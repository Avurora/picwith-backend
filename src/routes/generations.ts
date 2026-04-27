import { Router, Request, Response } from 'express';
import OpenAI, { toFile } from 'openai';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router = Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /generations
router.post('/', async (req: Request, res: Response) => {
  const { userId, personId, inputImageBase64, personPhotoBase64s, deviceId } = req.body as {
    userId: string | null;
    personId: string | null;
    inputImageBase64: string;
    personPhotoBase64s: string[];
    deviceId: string;                  // Keychainデバイスid
  };

  if (!inputImageBase64 || !deviceId) {
    return res.status(400).json({ error: 'inputImageBase64 と deviceId は必須です' });
  }

  try {
    // デバイストライアルチェック（未ログイン時）
    let quality: 'low' | 'medium' | 'high' = 'low';
    let isFirstTrial = false;

    if (!userId) {
      // 未ログイン：デバイスの初回体験チェック
      const { data: trial } = await supabase
        .from('device_trials')
        .select('id')
        .eq('device_id', deviceId)
        .single();

      if (trial) {
        return res.status(403).json({ error: '無料体験は1回のみです。続けるにはアカウントを作成してください。' });
      }

      quality = 'high'; // 初回は高画質
      isFirstTrial = true;
    }

    // 1. 残り生成回数チェック（ログイン済みのみ）
    const yearMonth = new Date().toISOString().slice(0, 7);
    const { data: usage } = await supabase
      .from('monthly_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('year_month', yearMonth)
      .single();

    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();

    const limits: Record<string, number> = { free: 3, ume: 10, take: 20, matsu: 50 };
    const plan = profile?.plan ?? 'free';
    const currentCount = usage?.count ?? 0;
    const limit = limits[plan];

    if (userId && currentCount >= limit) {
      return res.status(403).json({ error: '今月の生成回数上限に達しました' });
    }

    if (userId) {
      quality = plan === 'matsu' ? 'high' : 'medium';
    }

    // 2. 場所写真をStorageに保存
    const inputBuffer = Buffer.from(inputImageBase64, 'base64');
    const inputPath = `${userId}/${Date.now()}_input.jpg`;
    await supabase.storage.from('input-photos').upload(inputPath, inputBuffer, {
      contentType: 'image/jpeg',
    });

    // 3. プロンプト生成
    const prompt = buildPrompt();

    // 4. gpt-image-2でコラージュ生成
    // 入力画像をファイルとして用意
    const tmpDir = os.tmpdir();
    const inputFile = path.join(tmpDir, `input_${Date.now()}.jpg`);
    fs.writeFileSync(inputFile, inputBuffer);

    // 人物写真があれば追加（最大4枚）
    const personFiles: string[] = [];
    for (const b64 of personPhotoBase64s.slice(0, 4)) {
      const tmpFile = path.join(tmpDir, `person_${Date.now()}_${Math.random()}.jpg`);
      fs.writeFileSync(tmpFile, Buffer.from(b64, 'base64'));
      personFiles.push(tmpFile);
    }

    const imageUploadable = await toFile(fs.createReadStream(inputFile), 'input.jpg', { type: 'image/jpeg' });

    const response = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageUploadable,
      prompt,
      n: 1,
      size: '1024x1024',
    });

    // 一時ファイルを削除
    fs.unlinkSync(inputFile);
    personFiles.forEach((f) => { try { fs.unlinkSync(f); } catch {} });

    const outputB64 = response.data?.[0]?.b64_json;
    if (!outputB64) throw new Error('画像生成に失敗しました');

    // 5. 生成画像をStorageに保存
    const outputBuffer = Buffer.from(outputB64, 'base64');
    const outputPath = `${userId}/${Date.now()}_output.jpg`;
    await supabase.storage.from('output-images').upload(outputPath, outputBuffer, {
      contentType: 'image/jpeg',
    });

    // 6. デバイストライアルを記録 / monthly_usage を +1
    if (isFirstTrial) {
      await supabase.from('device_trials').insert({
        device_id: deviceId,
        used_at: new Date().toISOString(),
      });
    }

    if (userId && usage) {
      await supabase
        .from('monthly_usage')
        .update({ count: currentCount + 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('year_month', yearMonth);
    } else if (userId) {
      await supabase.from('monthly_usage').insert({
        user_id: userId,
        year_month: yearMonth,
        count: 1,
      });
    }

    // 7. generations にレコード挿入（ログイン済みのみ）
    const { data: generation } = userId ? await supabase
      .from('generations')
      .insert({
        user_id: userId,
        person_id: personId ?? null,
        input_path: inputPath,
        output_path: outputPath,
        quality,
      })
      .select()
      .single() : { data: null };

    // 8. 生成画像のURLを返す
    const { data: urlData } = supabase.storage
      .from('output-images')
      .getPublicUrl(outputPath);

    const remaining = userId ? limit - (currentCount + 1) : 0;

    return res.json({
      generationId: generation?.id ?? null,
      outputUrl: urlData.publicUrl,
      remaining,
      isFirstTrial,
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message ?? '生成に失敗しました' });
  }
});

function buildPrompt(): string {
  return [
    'Create a 2x4 grid collage (8 panels) showing a person in 8 different poses at the location shown in the reference image.',
    'Each panel should show the full body of the person in a distinct, natural pose suitable for the location.',
    'If a reference photo of a person is provided, use their appearance and clothing style.',
    'If no person reference is provided, use a stylish anonymous figure.',
    'Keep the background consistent with the location photo across all panels.',
    'Make the collage visually clean with thin white dividing lines between panels.',
    'Output as a single 1024x1024 image.',
  ].join(' ');
}

export default router;
