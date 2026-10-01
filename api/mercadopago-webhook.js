import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ======================================================
// VALIDAR ASSINATURA DO MERCADO PAGO
// ======================================================

function validateSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];

  if (!secret || !xSignature || !xRequestId || !dataId) {
    console.error('Dados ausentes para validar assinatura', {
      hasSecret: !!secret,
      hasSignature: !!xSignature,
      hasRequestId: !!xRequestId,
      hasDataId: !!dataId
    });

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
    console.error('x-signature incompleto');
    return false;
  }

  // O Mercado Pago usa o data.id recebido na URL
  const normalizedDataId = String(dataId).toLowerCase();

  const manifest =
    `id:${normalizedDataId};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const calculatedHash = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  try {
    const receivedBuffer = Buffer.from(receivedHash, 'hex');
    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');

    if (receivedBuffer.length !== calculatedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    );
  } catch (error) {
    console.error('Erro ao comparar assinatura:', error);
    return false;
  }
}

// ======================================================
// WEBHOOK
// ======================================================

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {

    // --------------------------------------------------
    // IMPORTANTE:
    // assinatura usa data.id DA URL
    // --------------------------------------------------

    const dataId = req.query?.['data.id'];

    // ID do pagamento que será consultado
    const paymentId =
      dataId ||
      req.body?.data?.id;

    console.log('Webhook Mercado Pago recebido', {
      type: req.body?.type,
      action: req.body?.action,
      paymentId,
      dataId
    });

    if (!paymentId) {
      console.log('Webhook sem ID de pagamento.');

      return res.status(200).json({
        ok: true
      });
    }

    // --------------------------------------------------
    // VALIDAR ASSINATURA
    // --------------------------------------------------

    if (!validateSignature(req, dataId)) {

      console.error(
        'Assinatura do Mercado Pago inválida'
      );

      return res.status(401).json({
        error: 'Assinatura inválida'
      });
    }

    console.log('Assinatura Mercado Pago válida.');

    // --------------------------------------------------
    // CONSULTAR PAGAMENTO NO MERCADO PAGO
    // --------------------------------------------------

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization:
            `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const payment = await response.json();

    if (!response.ok) {

      console.error(
        'Erro ao consultar pagamento no Mercado Pago:',
        payment
      );

      // Retorna 200 para evitar repetição infinita
      // da mesma notificação
      return res.status(200).json({
        ok: true
      });
    }

    console.log('Pagamento consultado:', {
      id: payment.id,
      status: payment.status,
      external_reference: payment.external_reference
    });

    // --------------------------------------------------
    // CONVERTER STATUS
    // --------------------------------------------------

    let statusPedido = payment.status;

    if (payment.status === 'approved') {
      statusPedido = 'pago';
    }

    if (payment.status === 'pending') {
      statusPedido = 'pendente';
    }

    if (payment.status === 'in_process') {
      statusPedido = 'processando';
    }

    if (payment.status === 'rejected') {
      statusPedido = 'rejeitado';
    }

    if (payment.status === 'cancelled') {
      statusPedido = 'cancelado';
    }

    if (payment.status === 'refunded') {
      statusPedido = 'reembolsado';
    }

    if (payment.status === 'charged_back') {
      statusPedido = 'estornado';
    }

    // --------------------------------------------------
    // ATUALIZAR PEDIDO NO SUPABASE
    // --------------------------------------------------

    const { data: pedidosAtualizados, error } =
      await supabase
        .from('pedidos')
        .update({
          status: statusPedido,
          id_do_pagamento: String(payment.id)
        })
        .eq(
          'id_do_pagamento',
          String(payment.id)
        )
        .select();

    if (error) {

      console.error(
        'Erro ao atualizar pedido no Supabase:',
        error
      );

      return res.status(500).json({
        error: 'Erro ao atualizar pedido'
      });
    }

    console.log(
      'Pedidos atualizados:',
      pedidosAtualizados
    );

    // --------------------------------------------------
    // SUCESSO
    // --------------------------------------------------

    return res.status(200).json({
      ok: true,
      payment_id: String(payment.id),
      payment_status: payment.status,
      order_status: statusPedido,
      updated: pedidosAtualizados?.length || 0
    });

  } catch (error) {

    console.error(
      'Erro geral no webhook:',
      error
    );

    return res.status(500).json({
      error: 'Erro interno'
    });
  }
}