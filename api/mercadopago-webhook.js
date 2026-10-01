import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function validateSignature(req, paymentId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];

  if (!secret || !xSignature || !xRequestId || !paymentId) {
    return false;
  }

  const parts = {};

  for (const part of xSignature.split(',')) {
    const [key, value] = part.split('=');

    if (key && value) {
      parts[key.trim()] = value.trim();
    }
  }

  const ts = parts.ts;
  const receivedHash = parts.v1;

  if (!ts || !receivedHash) {
    return false;
  }

  const manifest =
    `id:${String(paymentId).toLowerCase()};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const calculatedHash = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  const receivedBuffer = Buffer.from(receivedHash, 'hex');
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex');

  if (
    receivedBuffer.length !== calculatedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    calculatedBuffer
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {
    const paymentId =
      req.body?.data?.id ||
      req.query?.['data.id'];

    if (!paymentId) {
      return res.status(200).json({ ok: true });
    }

    // Validar se a notificação realmente veio do Mercado Pago
    if (!validateSignature(req, paymentId)) {
      console.error('Assinatura do webhook inválida');

      return res.status(401).json({
        error: 'Assinatura inválida'
      });
    }

    // Consultar o pagamento diretamente no Mercado Pago
    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await response.json();

    if (!response.ok) {
      console.error(
        'Erro ao consultar Mercado Pago:',
        payment
      );

      return res.status(200).json({ ok: true });
    }

    const orderId = payment.external_reference;

    if (!orderId) {
      return res.status(200).json({ ok: true });
    }

    // Atualizar pedido
    const { error } = await supabase
      .from('orders')
      .update({
        status: payment.status,
        payment_id: String(payment.id)
      })
      .eq('id', orderId);

    if (error) {
      console.error(
        'Erro ao atualizar pedido:',
        error
      );

      return res.status(500).json({
        error: 'Erro ao atualizar pedido'
      });
    }

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error('Erro webhook:', error);

    return res.status(500).json({
      error: 'Erro interno'
    });
  }
}