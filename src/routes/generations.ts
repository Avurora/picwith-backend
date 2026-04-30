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

// フレーム画像: backend/assets/
const ASSETS = path.join(__dirname, '../../assets');
const FRAME_SQUARE = path.join(ASSETS, 'frame-square.jpg'); // 2列×2行（無料プラン）
const FRAME_WIDE   = path.join(ASSETS, 'frame-wide.jpg');   // 4列×2行（有料・横長）
const FRAME_HEIGHT = path.join(ASSETS, 'frame-height.jpg'); // 2列×4行（有料・縦長）

// 無料プラン: 2×2 正方形 → 4枚出力
const GRID_FREE   = { cols: 2, rows: 2, size: '1024x1024' as const, w: 1024, h: 1024 };
// 有料プラン: 横長選択 → 4×2 → 8枚出力
const GRID_WIDE   = { cols: 4, rows: 2, size: '1536x1024' as const, w: 1536, h: 1024 };
// 有料プラン: 縦長選択 → 2×4 → 8枚出力
const GRID_HEIGHT = { cols: 2, rows: 4, size: '1024x1536' as const, w: 1024, h: 1536 };

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

// 無料プランの各セルに "PicWith" ウォーターマークを合成
async function addWatermark(buf: Buffer): Promise<Buffer> {
  const { width = 512, height = 512 } = await sharp(buf).metadata();
  const fontSize = Math.round(Math.min(width, height) * 0.07);
  const pad = Math.round(fontSize * 0.65);
  // SVGで右下にテキスト描画
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text
      x="${width - pad}" y="${height - pad}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${fontSize}px" font-weight="bold"
      fill="rgba(255,255,255,0.60)" text-anchor="end"
    >PicWith</text>
  </svg>`;
  return sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// 分割 + オプションで2倍アップスケール
export async function splitImage(
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

function buildPrompt(cols: number, rows: number, numPersonPhotos: number, userRequest?: string): string {
  const total = cols * rows;

  // 各入力画像の役割を明示（AIが何がどの画像かを正確に理解できるよう）
  const personRange = numPersonPhotos === 1
    ? `image 2 (person_0.jpg) is`
    : `images 2 to ${numPersonPhotos + 1} (person_0.jpg … person_${numPersonPhotos - 1}.jpg) are`;
  const imageRoles = [
    `IMAGE ROLES — follow these assignments strictly:`,
    `• image 1 (background.jpg): the LOCATION photo. This defines the scene, environment, architecture, lighting, time of day, and atmosphere. Do NOT change any of these.`,
    numPersonPhotos > 0
      ? `• ${personRange} PERSON REFERENCE photo(s). Use ALL of them to faithfully reconstruct this specific individual — match their face shape, eyes, nose, mouth, skin tone, hair color, hairstyle, and body proportions EXACTLY. This person must appear identically across every panel.`
      : null,
    `• last image (frame.jpg): the ${cols}×${rows} GRID TEMPLATE with alternating orange and teal cells. Each cell defines one output panel boundary — do not let content bleed between cells.`,
  ].filter(Boolean).join(' ');

  const lines = [
    imageRoles,

    // 出力品質（入力画像は圧縮済みだが出力は最高品質で）
    `Generate a single ultra-high-quality, sharp, detailed photorealistic image at maximum fidelity — the input reference photos may be low resolution, but the output must be rendered at the highest possible quality and detail.`,

    // グリッド構造
    `The output must exactly fill the ${cols}×${rows} grid — each colored cell in the frame template becomes one distinct scene panel, for a total of ${total} panels.`,

    // 人物と背景（背景のシチュエーションは極力変えない）
    `Each panel must show the person naturally present at the SAME location. Preserve the background scenery, architecture, lighting, time of day, weather, and atmosphere exactly as in background.jpg — do NOT replace, alter, or reimagine the environment.`,

    // ポーズのバリエーション（現実的・写真的なバリエーション）
    `Across all ${total} panels, present diverse and natural pose variations as if shot during a professional photo session at that location: vary standing, sitting, crouching, walking, looking in different directions, interacting naturally with the surroundings, and use different camera distances (close-up portrait, mid-shot, full-body). Every panel must show a clearly different pose or moment.`,

    // 人物の一貫性（再現性の強調）
    `CRITICAL: The person's identity must be consistent and faithful in every single panel. Reproduce the face, skin tone, hair, and body with high accuracy from the reference photos. Do not generalize or average their appearance — match this specific individual.`,

    // リアリズム厳守（非現実的な描写はNG）
    `All panels must look exactly like genuine photographs shot by a professional photographer at that real location — no illustrations, no paintings, no CGI, no stylized or surreal elements, no fantasy or impossible poses. The output must be completely indistinguishable from real photographs.`,

    // シームレスグリッド
    `No visible borders, grid lines, or gaps between panels — fill every cell seamlessly edge to edge.`,
  ];

  // ユーザーのカスタムリクエスト（倫理・アプリ理念に反するものはバックエンドで除外済み）
  if (userRequest && userRequest.trim().length > 0) {
    lines.push(
      `Additional user request — prioritize this when it does not conflict with the above rules: ${userRequest.trim()}`
    );
  }

  return lines.join(' ');
}

// ────────────────────────────────────────────────────
// Batch API 用: 画像バッファをOpenAI Files APIにアップロード
// ────────────────────────────────────────────────────
async function uploadImageFile(buf: Buffer, filename: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, buf);
  try {
    const fileObj = await openai.files.create({
      file: await toFile(fs.createReadStream(tmpPath), filename, { type: 'image/jpeg' }),
      purpose: 'vision',
    });
    return fileObj.id;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ────────────────────────────────────────────────────
// Batch API 用: バッチジョブを作成して batch_id を返す
// ────────────────────────────────────────────────────
export async function submitBatchJob(params: {
  generationId: string;
  resizedInput: Buffer;
  resizedPersons: Buffer[];
  framePath: string;
  grid: typeof GRID_FREE;
  prompt: string;
  ts: number;
}): Promise<string> {
  const { generationId, resizedInput, resizedPersons, framePath, grid, prompt, ts } = params;

  const frameBuffer = fs.readFileSync(framePath);

  // 全画像を並列でOpenAI Files APIにアップロード
  const [inputFileId, frameFileId, ...personFileIds] = await Promise.all([
    uploadImageFile(resizedInput, `bg_${ts}.jpg`),
    uploadImageFile(frameBuffer, `frame_${ts}.jpg`),
    ...resizedPersons.map((buf, i) => uploadImageFile(buf, `person_${ts}_${i}.jpg`)),
  ]);

  // 画像の順序: 背景 → 人物たち → フレーム
  const imageFileIds = [inputFileId, ...personFileIds, frameFileId];

  // バッチリクエストJSONLを作成
  const batchRequest = {
    custom_id: generationId,
    method: 'POST',
    url: '/v1/images/edits',
    body: {
      model: 'gpt-image-2',
      image: imageFileIds,
      prompt,
      n: 1,
      size: grid.size,
    },
  };

  const tmpJsonl = path.join(os.tmpdir(), `batch_${ts}.jsonl`);
  fs.writeFileSync(tmpJsonl, JSON.stringify(batchRequest) + '\n');

  try {
    // JSONLファイルをアップロード
    const batchFile = await openai.files.create({
      file: await toFile(fs.createReadStream(tmpJsonl), `batch_${ts}.jsonl`, { type: 'application/jsonl' }),
      purpose: 'batch',
    });

    // バッチジョブを作成（images.edit は SDK の型定義に未追加のため any キャスト）
    const batch = await openai.batches.create({
      input_file_id: batchFile.id,
      endpoint: '/v1/images/edits' as any,
      completion_window: '24h',
    });

    return batch.id;
  } finally {
    try { fs.unlinkSync(tmpJsonl); } catch {}
  }
}

// ────────────────────────────────────────────────────
// Batch完了後の後処理（server.ts のポーリングCronから呼ばれる）
// ────────────────────────────────────────────────────
export async function processBatchOutput(params: {
  generationId: string;
  userId: string;
  outputB64: string;
}): Promise<void> {
  const { generationId, userId, outputB64 } = params;
  const ts = Date.now();

  const collageBuffer = Buffer.from(outputB64, 'base64');
  const collagePath = `${userId}/${ts}_collage.jpg`;

  // コラージュ保存 + 分割を並列実行
  const [, rawCellBuffers] = await Promise.all([
    supabase.storage.from('output-images').upload(collagePath, collageBuffer, { contentType: 'image/jpeg' }),
    splitImage(collageBuffer, GRID_FREE.cols, GRID_FREE.rows, GRID_FREE.w, GRID_FREE.h),
  ]);

  // 無料プランはウォーターマーク合成
  const cellBuffers = await Promise.all(rawCellBuffers.map(addWatermark));

  // 分割画像を並列アップロード
  const splitPaths = await Promise.all(
    cellBuffers.map(async (buf, i) => {
      const splitPath = `${userId}/${ts}_split_${i}.jpg`;
      await supabase.storage.from('output-images').upload(splitPath, buf, { contentType: 'image/jpeg' });
      return splitPath;
    })
  );

  // DBを更新
  await supabase.from('generations').update({
    output_path: collagePath,
    split_paths: JSON.stringify(splitPaths),
    batch_status: 'completed',
  }).eq('id', generationId);
}

// ────────────────────────────────────────────────────
// メインルート: POST /generations
// ────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const { userId, personId, inputImageBase64, personPhotoBase64s, deviceId, orientation, userRequest } = req.body as {
    userId: string | null;
    personId: string | null;
    inputImageBase64: string;
    personPhotoBase64s: string[];
    deviceId: string;
    // 有料プランのみ使用: 'landscape' | 'portrait'（無料プランは常にsquare）
    orientation: 'landscape' | 'portrait' | null;
    // ユーザーの任意リクエスト（任意）
    userRequest?: string;
  };

  // 倫理・アプリ理念フィルタ: 暴力・性的・特定人物誹謗等のキーワードを含む場合は除外
  const BLOCKED_PATTERNS = [
    /nude|naked|sexual|explicit|porn|violence|violent|kill|blood|weapon|racist|hate|drug/i,
    /ヌード|裸|性的|暴力|殺|血|差別|ヘイト|薬物/,
  ];
  const sanitizedRequest = userRequest && !BLOCKED_PATTERNS.some(p => p.test(userRequest))
    ? userRequest
    : undefined;

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

    // 無料プランの制限: 月1回
    const limits: Record<string, number> = { free: 1, ume: 10, take: 20, matsu: 50 };
    const plan = profile?.plan ?? 'free';
    const currentCount = usageRow?.count ?? 0;
    const limit = limits[plan];

    if (userId && currentCount >= limit) {
      return res.status(403).json({ error: '今月の生成回数上限に達しました' });
    }
    if (userId) quality = plan === 'matsu' ? 'high' : 'medium';

    // 無料プラン判定（ゲスト or ログイン済みfreeプラン）
    const isFree = !userId || plan === 'free';

    // ── グリッド・フレーム決定 ────────────────────────────────────
    let grid: typeof GRID_FREE | typeof GRID_WIDE | typeof GRID_HEIGHT;
    let framePath: string;

    if (isFree) {
      grid = GRID_FREE;
      framePath = FRAME_SQUARE;
    } else if (orientation === 'landscape') {
      grid = GRID_WIDE;
      framePath = FRAME_WIDE;
    } else {
      grid = GRID_HEIGHT;
      framePath = FRAME_HEIGHT;
    }

    const inputBuffer = Buffer.from(inputImageBase64, 'base64');
    const ts = Date.now();
    const uid = userId ?? 'trial';
    const inputPath = `${uid}/${ts}_input.jpg`;

    // ── 入力画像リサイズ + 人物写真リサイズ を並列実行 ──
    const limitedPhotos = isFree ? personPhotoBase64s.slice(0, 1) : personPhotoBase64s;

    const [resizedInput, ...resizedPersons] = await Promise.all([
      resizeForApi(inputBuffer, 512),
      ...limitedPhotos.map(b64 => resizeForApi(Buffer.from(b64, 'base64'), 512)),
    ]);

    // Storage保存（APIとは独立）
    const inputUploadPromise = supabase.storage.from('input-photos')
      .upload(inputPath, inputBuffer, { contentType: 'image/jpeg' });

    const prompt = buildPrompt(grid.cols, grid.rows, resizedPersons.length, sanitizedRequest);

    // ── 使用量カウントアップ（先に+1してからAPIを呼ぶ）──────────────
    if (isFirstTrial) {
      await supabase.from('device_trials').insert({
        device_id: deviceId,
        used_at: new Date().toISOString(),
      });
    }

    let newCount = currentCount;
    if (userId && usageRow) {
      newCount = currentCount + 1;
      await supabase.from('monthly_usage')
        .update({ count: newCount, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('year_month', yearMonth);
    } else if (userId) {
      newCount = 1;
      await supabase.from('monthly_usage')
        .insert({ user_id: userId, year_month: yearMonth, count: 1 });
    }

    const remaining = userId ? limit - newCount : 0;

    // ── 無料プラン（ログイン済み）: Batch API で非同期生成 ───────────
    if (isFree && userId) {
      // generationsにpendingレコードを先行挿入
      const { data: generation } = await supabase.from('generations').insert({
        user_id: userId,
        person_id: personId ?? null,
        input_path: inputPath,
        output_path: null,
        split_paths: null,
        quality,
        batch_status: 'pending',
      }).select().single();

      const generationId = (generation as any)?.id;
      if (!generationId) throw new Error('generation ID の取得に失敗しました');

      // バッチジョブを投入（エラーがあればステータスをfailedに更新）
      submitBatchJob({ generationId, resizedInput, resizedPersons, framePath: framePath as typeof FRAME_SQUARE, grid: GRID_FREE, prompt, ts })
        .then(batchId => {
          supabase.from('generations')
            .update({ openai_batch_id: batchId })
            .eq('id', generationId)
            .then(() => {});
        })
        .catch(e => {
          console.error('[batch] バッチ投入エラー:', e);
          supabase.from('generations')
            .update({ batch_status: 'failed' })
            .eq('id', generationId)
            .then(() => {});
        });

      inputUploadPromise.catch(() => {});

      // 即座にレスポンス返却（クライアントはホームに戻れる）
      return res.status(202).json({
        generationId,
        outputUrls: [],
        remaining,
        isFirstTrial,
        status: 'pending',
      });
    }

    // ── ゲストユーザー or 有料プラン: 同期生成 ──────────────────────
    const tmpDir = os.tmpdir();
    const inputFile = path.join(tmpDir, `input_${ts}.jpg`);
    fs.writeFileSync(inputFile, resizedInput);

    const personFiles: string[] = [];
    for (let i = 0; i < resizedPersons.length; i++) {
      const f = path.join(tmpDir, `person_${ts}_${i}.jpg`);
      fs.writeFileSync(f, resizedPersons[i]);
      personFiles.push(f);
    }

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
      prompt,
      n: 1,
      size: grid.size,
    });

    [inputFile, ...personFiles].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    const outputB64 = response.data?.[0]?.b64_json;
    if (!outputB64) throw new Error('画像生成に失敗しました');

    const collageBuffer = Buffer.from(outputB64, 'base64');
    const collagePath   = `${uid}/${ts}_collage.jpg`;

    const [, rawCellBuffers] = await Promise.all([
      supabase.storage.from('output-images')
        .upload(collagePath, collageBuffer, { contentType: 'image/jpeg' }),
      splitImage(collageBuffer, grid.cols, grid.rows, grid.w, grid.h),
    ]);

    // ゲストユーザーのみウォーターマーク（有料プランはなし）
    const isGuestFree = !userId;
    const cellBuffers = isGuestFree
      ? await Promise.all(rawCellBuffers.map(addWatermark))
      : rawCellBuffers;

    const splitPaths = await Promise.all(
      cellBuffers.map(async (buf, i) => {
        const splitPath = `${uid}/${ts}_split_${i}.jpg`;
        await supabase.storage.from('output-images')
          .upload(splitPath, buf, { contentType: 'image/jpeg' });
        return splitPath;
      })
    );

    await inputUploadPromise.catch(() => {});

    const { data: generation } = userId
      ? await supabase.from('generations').insert({
          user_id: userId,
          person_id: personId ?? null,
          input_path: inputPath,
          output_path: collagePath,
          split_paths: JSON.stringify(splitPaths),
          quality,
          batch_status: null,
        }).select().single()
      : { data: null };

    const splitUrls = splitPaths.map(p =>
      supabase.storage.from('output-images').getPublicUrl(p).data.publicUrl
    );

    return res.json({
      generationId: (generation as any)?.id ?? null,
      outputUrls: splitUrls,
      remaining,
      isFirstTrial,
      status: 'completed',
    });

  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message ?? '生成に失敗しました' });
  }
});

export default router;
