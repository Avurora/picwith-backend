import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PRODUCT_PLAN_MAP: Record<string, string> = {
  picwith_ume_monthly: 'ume',
  picwith_take_monthly: 'take',
  picwith_matsu_monthly: 'matsu',
};

// POST /webhook/revenuecat
router.post('/revenuecat', async (req: Request, res: Response) => {
  const event = req.body;

  // RevenueCatのWebhook認証（Authorization headerチェック）
  const authHeader = req.headers.authorization;
  if (authHeader !== process.env.REVENUECAT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event: eventData } = event;
  const userId: string | undefined = eventData?.app_user_id;
  const productId: string | undefined = eventData?.product_id;
  const type: string = eventData?.type ?? '';

  if (!userId) return res.status(400).json({ error: 'user_id missing' });

  const plan = productId ? (PRODUCT_PLAN_MAP[productId] ?? 'free') : 'free';

  const isActive = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'BILLING_ISSUE_RESOLVED'].includes(type);
  const isCancelled = ['EXPIRATION', 'CANCELLATION'].includes(type);

  const status = isActive ? 'active' : isCancelled ? 'cancelled' : null;

  if (!status) return res.sendStatus(200);

  // subscriptionsテーブルを更新
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (existing) {
    await supabase
      .from('subscriptions')
      .update({
        plan: isCancelled ? 'free' : plan,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await supabase.from('subscriptions').insert({
      user_id: userId,
      plan: isCancelled ? 'free' : plan,
      status,
    });
  }

  // profilesのplanも更新
  await supabase
    .from('profiles')
    .update({ plan: isCancelled ? 'free' : plan })
    .eq('id', userId);

  return res.sendStatus(200);
});

export default router;
