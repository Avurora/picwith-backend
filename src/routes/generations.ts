import { Router, Request, Response } from 'express';
import OpenAI, { toFile } from 'openai';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router = Router();

// env var で切り替え可能 (UPSCALE_ENABLED=false で無効化)
const UPSCALE_ENABLED = process.env.UPSCALE_ENABLED !== 'false';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// フレーム画像: backend/assets/ (src/routes からの相対 = ../../assets/)
const ASSETS = path.join(__dirname, '../../assets');
const FRAME_WIDE   = path.join(ASSETS, 'frame-wide.jpg');   // 4列×2行
const FRAME_HEIGHT = path.join(ASSETS, 'frame-height.jpg'); // 2列×4行

// 有料プラン用グリッド
const GRID_WIDE   = { cols: 4, rows: 2, size: '1536x1024' as const, w: 1536, h: 1024 };
const GRID_HEIGHT = { cols: 2, rows: 4, size: '1024x1536' as const, w: 1024, h: 1536 };
// 無料プラン用グリッド（出力サイズを1024×1024に抑えてAPIコスト削減）
const GRID_WIDE_FREE   = { cols: 4, rows: 2, size: '1024x1024' as const, w: 1024, h: 1024 };
const GRID_HEIGHT_FREE = { cols: 2, rows: 4, size: '1024x1024' as const, w: 1024, h: 1024 };

// 入力画像をAPI送信前に最大maxPxにリサイズ（全プラン共通・コスト削減）
async function resizeForApi(buf: Buffer, maxPx = 512): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(buf).metadata();
  if (width <= maxPx && height <= maxPx) return buf;
  const scale = maxPx / Math.max(width, height);
  return sharp(buf)
    .resize(Math.round(width * scale), Math.round(height * scale))
    .jpeg({ quality: 85 })
    .toBuffer();
}

// 8分割 + オプションで2倍アップスケール
async function splitImage(
  buf: Buffer,
  cols: number,
  rows: number,
  totalW: number,
  totalH: number
): Promise<Buffer[]> {
  const cellW = Math.floor(totalW / cols);
  const cellH = Math.floor(totalH / rows);
  const cells: Buffer[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let cell = await sharp(buf)
        .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
        .jpeg({ quality: 92 })
        .toBuffer();

      if (UPSCALE_ENABLED) {
        cell = await sharp(cell)
          .resize(cellW * 2, cellH * 2, { kernel: sharp.kernel.lanczos3 })
          .jpeg({ quality: 90 })
          .toBuffer();
      }

      cells.push(cell);
    }
  }

  return cells;
}

function buildPrompt(cols: number, rows: number): string {
  const total = cols * rows;
  return [
    `You are given: (1) a background location photo, (2) one or more person reference photos, (3) a ${cols}×${rows} checkerboard frame template with alternating orange and teal cells.`,
    `Generate a single photorealistic image that exactly fills the ${cols}×${rows} grid defined by the checkerboard frame — each colored cell becomes one scene panel.`,
    `Each of the ${total} panels must show the person from the reference photos naturally present at the location from the background photo.`,
    `Across all ${total} panels, vary the pose, body language, distance, activity, and interaction with the environment — every panel must look distinctly different.`,
    `The person's face and physical appearance must closely match the reference photos.`,
    `Background and lighting must remain consistent with the location photo across all panels.`,
    `No visible borders, lines, or gaps between panels — fill every cell seamlessly edge to edge.`,
    `Output must be photorealistic, as if these are genuine photographs taken at that location.`,
  ].join(' ');
}

router.post('/', async (req: Request, res: Response) => {
  const { userId, personId, inputImageBase64, personPhotoBase64s, deviceId } = req.body as {
    userId: string | null;
    personId: string | null;
    inputImageBase64: string;
    personPhotoBase64s: string[];
    deviceId: string;
  };

  if (!inputImageBase64 || !deviceId) {
    return res.status(400).json({ error: 'inputImageBase64 と deviceId は必須です' });
  }

  try {
    // ── 残り回数チェック & quality ──────────────────────────────
    let quality: 'low' | 'medium' | 'high' = 'low';
    let isFirstTrial = false;

    if (!userId) {
      const { data: trial } = await supabase
        .from('device_trials').select('id').eq('device_id', deviceId).single();
      if (trial) {
        return res.status(403).json({ error: '無料体験は1回のみです。続けるにはアカウントを作成してください。' });
      }
      quality = 'high';
      isFirstTrial = true;
    }

    const yearMonth = new Date().toISOString().slice(0, 7);
    const { data: usageRow } = userId
      ? await supabase.from('monthly_usage').select('count')
          .eq('user_id', userId).eq('year_month', yearMonth).single()
      : { data: null };
    const { data: profile } = userId
      ? await supabase.from('profiles').select('plan').eq('id', userId).single()
      : { data: null };

    const limits: Record<string, number> = { free: 3, ume: 10, take: 20, matsu: 50 };
    const plan = profile?.plan ?? 'free';
    const currentCount = usageRow?.count ?? 0;
    const limit = limits[plan];

    if (userId && currentCount >= limit) {
      return res.status(403).json({ error: '今月の生成回数上限に達しました' });
    }
    if (userId) quality = plan === 'matsu' ? 'high' : 'medium';

    // 無料プラン判定（ゲスト or ログイン済みfreeプラン）
    const isFree = !userId || plan === 'free';

    // ── 入力画像の縦横判定 ──────────────────────────────────────
    const inputBuffer = Buffer.from(inputImageBase64, 'base64');
    const { width: imgW = 1, height: imgH = 1 } = await sharp(inputBuffer).metadata();

    // 縦長入力 → wideフレーム (4×2 → 各セルが縦長)
    // 横長入力 → heightフレーム (2×4 → 各セルが横長)
    const isPortrait = imgH >= imgW;
    // 無料プランは1024×1024出力でAPIコスト削減
    const grid      = isPortrait
      ? (isFree ? GRID_WIDE_FREE   : GRID_WIDE)
      : (isFree ? GRID_HEIGHT_FREE : GRID_HEIGHT);
    const framePath = isPortrait ? FRAME_WIDE  : FRAME_HEIGHT;

    // ── 場所写真を Storage 保存 ──────────────────────────────────
    const ts = Date.now();
    const uid = userId ?? 'trial';
    const inputPath = `${uid}/${ts}_input.jpg`;
    await supabase.storage.from('input-photos')
      .upload(inputPath, inputBuffer, { contentType: 'image/jpeg' });

    // ── 一時ファイル準備（全プラン: 512px以下にリサイズしてAPI転送量を削減）
    const tmpDir = os.tmpdir();
    const inputFile = path.join(tmpDir, `input_${ts}.jpg`);
    const resizedInput = await resizeForApi(inputBuffer, 512);
    fs.writeFileSync(inputFile, resizedInput);

    // 無料プランは人物写真を1枚に制限
    const limitedPhotos = isFree ? personPhotoBase64s.slice(0, 1) : personPhotoBase64s;

    const personFiles: string[] = [];
    for (let i = 0; i < limitedPhotos.length; i++) {
      const personBuf = await resizeForApi(Buffer.from(limitedPhotos[i], 'base64'), 512);
      const f = path.join(tmpDir, `person_${ts}_${i}.jpg`);
      fs.writeFileSync(f, personBuf);
      personFiles.push(f);
    }

    // ── gpt-image-2 呼び出し ────────────────────────────────────
    const imageInputs: Awaited<ReturnType<typeof toFile>>[] = [];

    imageInputs.push(
      await toFile(fs.createReadStream(inputFile), 'background.jpg', { type: 'image/jpeg' })
    );
    for (let i = 0; i < personFiles.length; i++) {
      imageInputs.push(
        await toFile(fs.createReadStream(personFiles[i]), `person_${i}.jpg`, { type: 'image/jpeg' })
      );
    }
    imageInputs.push(
      await toFile(fs.createReadStream(framePath), 'frame.jpg', { type: 'image/jpeg' })
    );

    const response = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageInputs as any,
      prompt: buildPrompt(grid.cols, grid.rows),
      n: 1,
      size: grid.size,
    });

    // 一時ファイル削除
    [inputFile, ...personFiles].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    const outputB64 = response.data?.[0]?.b64_json;
    if (!outputB64) throw new Error('画像生成に失敗しました');

    // ── コラージュ保存 ──────────────────────────────────────────
    const collageBuffer = Buffer.from(outputB64, 'base64');
    const collagePath   = `${uid}/${ts}_collage.jpg`;
    await supabase.storage.from('output-images')
      .upload(collagePath, collageBuffer, { contentType: 'image/jpeg' });

    // ── 8分割 & アップスケール ──────────────────────────────────
    const cellBuffers = await splitImage(collageBuffer, grid.cols, grid.rows, grid.w, grid.h);

    const splitPaths: string[] = [];
    for (let i = 0; i < cellBuffers.length; i++) {
      const splitPath = `${uid}/${ts}_split_${i}.jpg`;
      await supabase.storage.from('output-images')
        .upload(splitPath, cellBuffers[i], { contentType: 'image/jpeg' });
      splitPaths.push(splitPath);
    }

    // ── DB 記録 ─────────────────────────────────────────────────
    if (isFirstTrial) {
      await supabase.from('device_trials').insert({
        device_id: deviceId,
        used_at: new Date().toISOString(),
      });
    }

    if (userId && usageRow) {
      await supabase.from('monthly_usage')
        .update({ count: currentCount + 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('year_month', yearMonth);
    } else if (userId) {
      await supabase.from('monthly_usage')
        .insert({ user_id: userId, year_month: yearMonth, count: 1 });
    }

    const { data: generation } = userId
      ? await supabase.from('generations').insert({
          user_id: userId,
          person_id: personId ?? null,
          input_path: inputPath,
          output_path: collagePath,
          split_paths: JSON.stringify(splitPaths),
          quality,
        }).select().single()
      : { data: null };

    // ── レスポンス ──────────────────────────────────────────────
    const splitUrls = splitPaths.map(p =>
      supabase.storage.from('output-images').getPublicUrl(p).data.publicUrl
    );
    const remaining = userId ? limit - (currentCount + 1) : 0;

    return res.json({
      generationId: generation?.id ?? null,
      outputUrls: splitUrls,
      remaining,
      isFirstTrial,
    });

  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message ?? '生成に失敗しました' });
  }
});

export default router;
