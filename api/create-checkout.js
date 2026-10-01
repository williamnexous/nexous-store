import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {
    const { items, customer } = req.body;

    const customerData = {
  name: String(customer?.name || '').trim(),
  email: String(customer?.email || '').trim(),
  cpf: String(customer?.cpf || '').replace(/\D/g, ''),
  cep: String(customer?.cep || '').replace(/\D/g, ''),
  rua: String(customer?.rua || '').trim(),
  numero: String(customer?.numero || '').trim(),
  complemento: String(customer?.complemento || '').trim(),
  bairro: String(customer?.bairro || '').trim(),
  cidade: String(customer?.cidade || '').trim(),
  estado: String(customer?.estado || '').trim().toUpperCase()
};

    if (
      !customerData.name ||
      !customerData.email ||
      !customerData.cpf
    ) {
      return res.status(400).json({
        error: 'Nome, e-mail e CPF são obrigatórios!'
      });
    }

    if (customerData.cpf.length !== 11) {
      return res.status(400).json({
        error: 'CPF inválido.'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Carrinho vazio.'
      });
    }

    // IDs enviados pelo carrinho
    const ids = [...new Set(
      items.map(item => item.product_id || item.id)
    )];

    if (ids.some(id => !id)) {
      return res.status(400).json({
        error: 'Produto inválido no carrinho.'
      });
    }

    // Preços são sempre consultados no Supabase.
    // Nunca confiamos no preço enviado pelo navegador.
    const { data: products, error: productsError } =
      await supabase
        .from('products')
        .select('id,name,price,product_type')
        .in('id', ids)
        .eq('active', true);

    if (productsError) {
      throw productsError;
    }

    if (!products || products.length !== ids.length) {
      return res.status(400).json({
        error: 'Um ou mais produtos não estão disponíveis.'
      });
    }

    const productMap = new Map(
      products.map(product => [product.id, product])
    );

    let total = 0;

    const orderItems = items.map(item => {
      const product = productMap.get(
        item.product_id || item.id
      );

      if (!product) {
        throw new Error('Produto inválido.');
      }

      const quantity = Number(item.quantity);
      const size = String(item.size || '');

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        throw new Error('Quantidade inválida.');
      }

      const validSizes =
        product.product_type === 'tenis'
          ? ['38', '39', '40', '41', '42']
          : ['P', 'M', 'G'];

      if (!validSizes.includes(size)) {
        throw new Error(
          `Tamanho inválido para ${product.name}`
        );
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error('Preço inválido.');
      }

      total += price * quantity;

      return {
        product_id: product.id,
        product_name: product.name,
        size,
        quantity,
        unit_price: price
      };
    });

    total = Number(total.toFixed(2));

    // Criar pedido pendente
    const { data: order, error: orderError } =
      await supabase
        .from('orders')
        .insert({
          customer_name: customerData.name,
          customer_email: customerData.email,
          total,
          status: 'pending'
        })
        .select()
        .single();

    if (orderError) {
      throw orderError;
    }

    // Salvar os produtos do pedido
    const { error: itemsError } =
      await supabase
        .from('order_items')
        .insert(
          orderItems.map(item => ({
            ...item,
            order_id: order.id
          }))
        );

    if (itemsError) {
      throw itemsError;
    }

    // Dados enviados ao Mercado Pago
    const paymentBody = {
      transaction_amount: total,
      description: `Pedido NEXOUS ${order.id}`,
      payment_method_id: 'pix',

      payer: {
        email: customerData.email,
        first_name: customerData.name,
        identification: {
          type: 'CPF',
          number: customerData.cpf
        }
      },

      external_reference: String(order.id),

      notification_url:
        'https://nexous-store.vercel.app/api/mercadopago-webhook'
    };

    const idempotencyKey = crypto.randomUUID();

    const mpResponse = await fetch(
      'https://api.mercadopago.com/v1/payments',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          Authorization:
            `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'X-Idempotency-Key': idempotencyKey
        },

        body: JSON.stringify(paymentBody)
      }
    );

    const payment = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error(
        'Erro Mercado Pago:',
        JSON.stringify(payment)
      );

      return res.status(400).json({
        error: 'Não foi possível gerar o Pix.'
      });
    }

    // Salvar ID real do pagamento
    const { error: updateError } =
      await supabase
        .from('orders')
        .update({
          payment_id: String(payment.id),
          status: payment.status || 'pending'
        })
        .eq('id', order.id);

    if (updateError) {
      console.error(
        'Erro ao atualizar pedido:',
        updateError
      );
    }

    const transactionData =
      payment.point_of_interaction
        ?.transaction_data;

    if (
      !transactionData?.qr_code ||
      !transactionData?.qr_code_base64
    ) {
      return res.status(500).json({
        error: 'O Mercado Pago não retornou o QR Code do Pix.'
      });
    }

    // Dados que o index.html vai mostrar
    return res.status(200).json({
      order_id: order.id,
      payment_id: String(payment.id),
      status: payment.status,

      qr_code:
        transactionData.qr_code,

      qr_code_base64:
        transactionData.qr_code_base64
    });

  } catch (error) {
    console.error('Erro create-checkout:', error);

    return res.status(500).json({
      error: 'Erro ao gerar pagamento Pix.'
    });
  }
}
