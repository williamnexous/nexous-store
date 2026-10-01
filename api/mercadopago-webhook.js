import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    const paymentId =
      req.body?.data?.id ||
      req.query?.['data.id'];

    if (!paymentId) {
      return res.status(200).json({ ok: true });
    }

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await response.json();

    if (!response.ok) {
      console.error('Erro Mercado Pago:', payment);
      return res.status(200).json({ ok: true });
    }

    const orderId = payment.external_reference;

    if (!orderId) {
      return res.status(200).json({ ok: true });
    }

    const { error } = await supabase
      .from('orders')
      .update({
        status: payment.status,
        payment_id: String(payment.id)
      })
      .eq('id', orderId);

    if (error) {
      console.error('Erro Supabase:', error);
    }

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Erro webhook:', error);

    return res.status(200).json({ ok: true });
  }
}