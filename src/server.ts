import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import generationsRouter from './routes/generations';
import webhookRouter from './routes/webhook';
import { processBatchOutput } from './routes/generations';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/generations', generationsRouter);
app.use('/webhook', webhookRouter);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── ストレージ自動クリーンアップ ────────────────────────────────────
// 無料プラン・トライアルユーザーの画像を7日後に削除

async function cleanupOldImages() {
  const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDate = SEVEN_DAYS_AGO.toISOString();
  const cutoffMs = SEVEN_DAYS_AGO.getTime();

  console.log('[cleanup] 開始:', cutoffDate);

  try {
    // ── 1. トライアルユーザー（storage: trial/xxxxxxx_*.jpg）─────────
    for (const bucket of ['input-photos', 'output-images'] as const) {
      const { data: files } = await supabase.storage.from(bucket).list('trial', { limit: 1000 });
      if (!files || files.length === 0) continue;

      const old = files.filter(f => {
        const m = f.name.match(/^(\d+)_/);
        return m && parseInt(m[1]) < cutoffMs;
      });

      if (old.length > 0) {
        await supabase.storage.from(bucket).remove(old.map(f => `trial/${f.name}`));
        console.log(`[cleanup] ${bucket}/trial: ${old.length}件削除`);
      }
    }

    // ── 2. 無料プランユーザーの古い生成画像 ──────────────────────────
    const { data: freeProfiles } = await supabase
      .from('profiles')
      .select('id')
      .eq('plan', 'free');

    const freeIds = (freeProfiles ?? []).map((p: any) => p.id);
    if (freeIds.length === 0) {
      console.log('[cleanup] 完了（無料ユーザーなし）');
      return;
    }

    const { data: oldGens } = await supabase
      .from('generations')
      .select('id, input_path, output_path, split_paths')
      .in('user_id', freeIds)
      .lt('created_at', cutoffDate)
      .not('output_path', 'is', null);

    if (!oldGens || oldGens.length === 0) {
      console.log('[cleanup] 完了（削除対象なし）');
      return;
    }

    for (const gen of oldGens) {
      const inputPaths: string[] = gen.input_path ? [gen.input_path] : [];
      const outputPaths: string[] = [];

      if (gen.output_path) outputPaths.push(gen.output_path);
      if (gen.split_paths) {
        try {
          const splits: string[] = JSON.parse(gen.split_paths);
          outputPaths.push(...splits);
        } catch {}
      }

      if (inputPaths.length > 0) {
        await supabase.storage.from('input-photos').remove(inputPaths);
      }
      if (outputPaths.length > 0) {
        await supabase.storage.from('output-images').remove(outputPaths);
      }

      // DBのパスをnullに（履歴エントリは残す・「削除済み」状態）
      await supabase.from('generations')
        .update({ output_path: null, split_paths: null })
        .eq('id', gen.id);
    }

    console.log(`[cleanup] 完了: ${oldGens.length}件の生成画像を削除`);
  } catch (e) {
    console.error('[cleanup] エラー:', e);
  }
}

// ── Expo Push通知送信 ──────────────────────────────────────────────
async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data: Record<string, any>
): Promise<void> {
  const { data: tokens } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);

  if (!tokens || tokens.length === 0) return;

  // Expo Push API に一括送信
  const messages = tokens.map(({ token }: { token: string }) => ({
    to: token,
    title,
    body,
    data,
    sound: 'default',
  }));

  const resp = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!resp.ok) {
    console.error('[push] 送信エラー:', await resp.text());
  }
}

// ── Batch API ポーリング ────────────────────────────────────────────
// 5分ごとにpendingなバッチジョブを確認し、完了したら後処理+プッシュ通知

async function pollBatchJobs() {
  const { data: pending } = await supabase
    .from('generations')
    .select('id, user_id, openai_batch_id')
    .eq('batch_status', 'pending')
    .not('openai_batch_id', 'is', null);

  if (!pending || pending.length === 0) return;

  console.log(`[batch-poll] pending: ${pending.length}件`);

  for (const gen of pending as Array<{ id: string; user_id: string; openai_batch_id: string }>) {
    try {
      const batch = await openai.batches.retrieve(gen.openai_batch_id);

      if (batch.status === 'completed' && batch.output_file_id) {
        // バッチ出力ファイルをダウンロード
        const outputFileResp = await openai.files.content(batch.output_file_id);
        const text = await (outputFileResp as any).text();

        let processed = false;
        for (const line of text.split('\n').filter(Boolean)) {
          const result = JSON.parse(line);
          if (result.custom_id !== gen.id) continue;

          if (result.response?.status_code !== 200) {
            console.error('[batch-poll] バッチレスポンスエラー:', result.error);
            await supabase.from('generations')
              .update({ batch_status: 'failed' })
              .eq('id', gen.id);
            await sendPushNotification(
              gen.user_id,
              '⚠️ 生成に失敗しました',
              'もう一度お試しください',
              {}
            );
            processed = true;
            break;
          }

          const outputB64 = result.response?.body?.data?.[0]?.b64_json;
          if (!outputB64) {
            console.error('[batch-poll] b64_json が見つかりません');
            await supabase.from('generations').update({ batch_status: 'failed' }).eq('id', gen.id);
            processed = true;
            break;
          }

          // 画像後処理（分割・ウォーターマーク・Storage保存）
          await processBatchOutput({ generationId: gen.id, userId: gen.user_id, outputB64 });

          // 完了プッシュ通知
          await sendPushNotification(
            gen.user_id,
            '✨ 生成完了！',
            'PicWithの画像が完成しました。タップして確認してください。',
            { generationId: gen.id }
          );

          console.log(`[batch-poll] 完了: ${gen.id}`);
          processed = true;
          break;
        }

        if (!processed) {
          // custom_id が見つからない場合（通常発生しない）
          console.warn(`[batch-poll] custom_id ${gen.id} が出力に見つかりません`);
        }

      } else if (batch.status === 'failed' || batch.status === 'expired' || batch.status === 'cancelled') {
        console.error(`[batch-poll] バッチ失敗 (${batch.status}): ${gen.id}`);
        await supabase.from('generations')
          .update({ batch_status: 'failed' })
          .eq('id', gen.id);
        await sendPushNotification(
          gen.user_id,
          '⚠️ 生成に失敗しました',
          'もう一度お試しください',
          {}
        );
      }
      // status が 'in_progress' / 'validating' / 'finalizing' の場合は次のポーリングまで待機

    } catch (e) {
      console.error(`[batch-poll] エラー (${gen.id}):`, e);
    }
  }
}

// 毎日午前3時（JST）に実行 → UTC 18:00
cron.schedule('0 18 * * *', cleanupOldImages);

// 5分ごとにバッチジョブをポーリング
cron.schedule('*/5 * * * *', pollBatchJobs);

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`PicWith backend running on port ${port}`));
