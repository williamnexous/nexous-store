import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.URL_SUPABASE;

const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const mercadoPagoToken =
  process.env.MP_ACCESS_TOKEN;

const webhookSecret =
  process.env.MP_WEBHOOK_SECRET;

if (!supabaseUrl) {
  throw new Error(
    'SUPABASE_URL/URL_SUPABASE não configurada na Vercel'
  );
}

if (!supabaseServiceKey) {
  throw new Error(
    'SUPABASE_SERVICE_ROLE_KEY não configurada na Vercel'
  );
}

if (!mercadoPagoToken) {
  throw new Error(
    'MP_ACCESS_TOKEN não configurado na Vercel'
  );
}

const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey
);

// ======================================================
// VALIDAR ASSINATURA MERCADO PAGO
// ======================================================

function validateSignature(req, dataId) {
  if (!webhookSecret) {
    console.error('MP_WEBHOOK_SECRET não configurado.');
    return false;
  }

  const xSignature =
    req.headers['x-signature'];

  const xRequestId =
    req.headers['x-request-id'];

  if (
    !xSignature ||
    !xRequestId ||
    !dataId
  ) {
    console.error(
      'Dados ausentes para validar assinatura:',
      {
        hasSecret: !!webhookSecret,
        hasSignature: !!xSignature,
        hasRequestId: !!xRequestId,
        hasDataId: !!dataId
      }
    );

    return false;
  }

  const parts = {};

  for (const part of xSignature.split(',')) {
    const [key, value] = part.split('=');

    if (key && value) {
      parts[key.trim()] =
        value.trim();
    }
  }

  const ts = parts.ts;
  const receivedHash = parts.v1;

  if (!ts || !receivedHash) {
    console.error(
      'Cabeçalho x-signature incompleto.'
    );

    return false;
  }

  const normalizedDataId =
    String(dataId).toLowerCase();

  const manifest =
    `id:${normalizedDataId};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const calculatedHash = crypto
    .createHmac(
      'sha256',
      webhookSecret
    )
    .update(manifest)
    .digest('hex');

  try {
    const receivedBuffer =
      Buffer.from(
        receivedHash,
        'hex'
      );

    const calculatedBuffer =
      Buffer.from(
        calculatedHash,
        'hex'
      );

    if (
      receivedBuffer.length !==
      calculatedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      receivedBuffer,
      calculatedBuffer
    );

  } catch (error) {
    console.error(
      'Erro ao validar assinatura:',
      error
    );

    return false;
  }
}

// ======================================================
// CONVERTER STATUS
// ======================================================

function convertPaymentStatus(status) {
  switch (status) {
    case 'approved':
      return 'pago';

    case 'pending':
      return 'pendente';

    case 'in_process':
      return 'processando';

    case 'rejected':
      return 'rejeitado';

    case 'cancelled':
      return 'cancelado';

    case 'refunded':
      return 'reembolsado';

    case 'charged_back':
      return 'estornado';

    default:
      return status || 'pendente';
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

    // ==================================================
    // PEGAR ID DO PAGAMENTO
    // ==================================================

    const dataId =
      req.query?.['data.id'];

    const bodyPaymentId =
      req.body?.data?.id;

    const paymentId =
      dataId ||
      bodyPaymentId;

    console.log(
      'Webhook Mercado Pago recebido:',
      {
        type: req.body?.type,
        action: req.body?.action,
        dataId,
        bodyPaymentId,
        paymentId
      }
    );

    if (!paymentId) {
      console.log(
        'Notificação sem payment ID.'
      );

      return res.status(200).json({
        ok: true,
        ignored: true
      });
    }

    // ==================================================
    // VALIDAR ASSINATURA
    // ==================================================

    if (
      !validateSignature(
        req,
        dataId
      )
    ) {
      console.error(
        'Assinatura Mercado Pago inválida.'
      );

      return res.status(401).json({
        error:
          'Assinatura inválida'
      });
    }

    console.log(
      'Assinatura Mercado Pago válida.'
    );

    // ==================================================
    // CONSULTAR PAGAMENTO
    // ==================================================

    const mpResponse =
      await fetch(
        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
        {
          method: 'GET',

          headers: {
            Authorization:
              `Bearer ${mercadoPagoToken}`,

            'Content-Type':
              'application/json'
          }
        }
      );

    const payment =
      await mpResponse.json();

    if (!mpResponse.ok) {
      console.error(
        'Erro Mercado Pago:',
        payment
      );

      return res.status(200).json({
        ok: true,
        ignored: true,
        reason:
          'payment_not_found'
      });
    }

    console.log(
      'Pagamento encontrado:',
      {
        id: payment.id,
        status: payment.status,
        external_reference:
          payment.external_reference
      }
    );

    // ==================================================
    // CONVERTER STATUS
    // ==================================================

    const orderStatus =
      convertPaymentStatus(
        payment.status
      );

    // ==================================================
    // LOCALIZAR PEDIDO
    // ==================================================

    const paymentIdString =
      String(payment.id);

    let {
      data: order,
      error: findError
    } = await supabase
      .from('orders')
      .select(
        'id,payment_id,status,total'
      )
      .eq(
        'payment_id',
        paymentIdString
      )
      .maybeSingle();

    if (findError) {
      console.error(
        'Erro procurando pedido por payment_id:',
        findError
      );

      return res.status(500).json({
        error:
          'Erro procurando pedido'
      });
    }

    // ==================================================
    // FALLBACK PELO external_reference
    // ==================================================

    if (
      !order &&
      payment.external_reference
    ) {
      console.log(
        'Pedido não encontrado por payment_id. Tentando external_reference.'
      );

      const {
        data: orderByReference,
        error: referenceError
      } = await supabase
        .from('orders')
        .select(
          'id,payment_id,status,total'
        )
        .eq(
          'id',
          String(
            payment.external_reference
          )
        )
        .maybeSingle();

      if (referenceError) {
        console.error(
          'Erro procurando external_reference:',
          referenceError
        );

        return res.status(500).json({
          error:
            'Erro procurando pedido'
        });
      }

      order =
        orderByReference;
    }

    // ==================================================
    // PEDIDO NÃO ENCONTRADO
    // ==================================================

    if (!order) {
      console.error(
        'Nenhum pedido correspondente encontrado.',
        {
          paymentId:
            paymentIdString,

          externalReference:
            payment.external_reference
        }
      );

      return res.status(200).json({
        ok: true,
        updated: 0,
        reason:
          'order_not_found'
      });
    }

    console.log(
      'Pedido encontrado:',
      {
        orderId: order.id,
        oldStatus:
          order.status,
        newStatus:
          orderStatus
      }
    );

    // ==================================================
    // ATUALIZAR PEDIDO
    // ==================================================

    const {
      data: updatedOrder,
      error: updateError
    } = await supabase
      .from('orders')
      .update({
        status:
          orderStatus,

        payment_id:
          paymentIdString
      })
      .eq(
        'id',
        order.id
      )
      .select()
      .single();

    if (updateError) {
      console.error(
        'Erro ao atualizar order:',
        updateError
      );

      return res.status(500).json({
        error:
          'Erro ao atualizar pedido'
      });
    }

    console.log(
      'PEDIDO ATUALIZADO COM SUCESSO:',
      {
        id:
          updatedOrder.id,

        payment_id:
          updatedOrder.payment_id,

        status:
          updatedOrder.status
      }
    );

    // ==================================================
    // SUCESSO
    // ==================================================

    return res.status(200).json({
      ok: true,

      order_id:
        updatedOrder.id,

      payment_id:
        paymentIdString,

      payment_status:
        payment.status,

      order_status:
        updatedOrder.status,

      updated: 1
    });

  } catch (error) {

    console.error(
      'Erro geral no webhook:',
      error
    );

    return res.status(500).json({
      error:
        'Erro interno do webhook'
    });
  }
}