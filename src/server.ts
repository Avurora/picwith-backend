import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import generationsRouter from './routes/generations';
import webhookRouter from './routes/webhook';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/generations', generationsRouter);
app.use('/webhook', webhookRouter);

// ── ストレージ自動クリーンアップ ────────────────────────────────────
// 無料プラン・トライアルユーザーの画像を30日後に削除

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function cleanupOldImages() {
  const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDate = SEVEN_DAYS_AGO.toISOString();
  const cutoffMs = SEVEN_DAYS_AGO.getTime();

  console.log('[cleanup] 開始:', cutoffDate);

  try {
    // ── 1. トライアルユーザー（storage: trial/xxxxxxx_*.jpg）─────────
    // ファイル名の先頭タイムスタンプで30日超かを判定
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
    // profilesからfreeプランのuser_idを取得
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

      // ストレージから削除
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

// 毎日午前3時（JST）に実行 → UTC 18:00
cron.schedule('0 18 * * *', cleanupOldImages);

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`PicWith backend running on port ${port}`));
