import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {lookupCep,totalsForRegion} from '../frete-utils.js';

export function createCheckoutHandler(supabase,paymentFetch=fetch,cepLookup=lookupCep) {
return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido'
    });
  }

  try {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({error:'Entre na sua conta para comprar e acompanhar o pedido.'});
    const {data:auth,error:authError} = await supabase.auth.getUser(token);
    if (authError || !auth?.user) return res.status(401).json({error:'Entre novamente na sua conta.'});
    if (!auth.user.email_confirmed_at) return res.status(403).json({error:'Confirme seu e-mail antes de comprar.'});
    const { items, customer, expected_total } = req.body || {};

    const customerData = {
  name: String(customer?.name || '').trim(),
  email: auth.user.email,
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
  !customerData.cep ||
  !customerData.rua ||
  !customerData.numero ||
  !customerData.bairro ||
  !customerData.cidade ||
  !customerData.estado
) {
  return res.status(400).json({
    error: 'Preencha todos os campos obrigatórios do endereço.'
  });
}

if (customerData.cep.length !== 8) {
  return res.status(400).json({
    error: 'CEP inválido.'
  });
}

if (customerData.estado.length !== 2) {
  return res.status(400).json({
    error: 'Estado inválido. Use a sigla, por exemplo: RS.'
  });
}
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

    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
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
        .select('id,name,price,product_type,sizes,category')
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

      if(!['Nike', 'Lacoste', 'Adidas', 'All Star', 'Puma', 'New Balance', 'Chuteiras', 'Chinelos'].includes(product.category))throw Object.assign(new Error('Este produto não faz parte do catálogo atual.'),{status:400});
      const quantity = Number(item.quantity);
      const size = String(item.size || (product.product_type === 'acessorio' ? 'Único' : ''));

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        throw new Error('Quantidade inválida.');
      }

      const validSizes = product.product_type === 'acessorio'
        ? ['Único']
        : Array.isArray(product.sizes) && product.sizes.length
          ? product.sizes.map(String)
          : product.product_type === 'tenis'
            ? ['38','39','40','41','42']
            : ['P','M','G','GG'];

      if (!validSizes.includes(size)) {
        throw new Error(
          `Tamanho inválido para ${product.name}`
        );
      }

      const price = Math.round(Number(product.price)*100)/100;

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

    if(Math.round(total*100)<49900)return res.status(409).json({error:'Consulte o frete pelo WhatsApp antes de combinar o pagamento. O Pix no site está disponível para compras com frete grátis a partir de R$ 499,00.'});
    const destination=await cepLookup(customerData.cep);
    if(destination.uf!==customerData.estado)return res.status(400).json({error:'O estado informado não corresponde ao CEP. Calcule o frete novamente.'});
    const pricing=totalsForRegion(Math.round(total*100),destination.uf);
    if(!Number.isFinite(Number(expected_total))||Math.round(Number(expected_total)*100)!==Math.round(pricing.total*100))return res.status(409).json({error:'O valor da compra mudou. Calcule o frete novamente antes de gerar o Pix.',pricing});
    total=pricing.total;

    // Criar pedido pendente
    const { data: order, error: orderError } =
      await supabase
        .from('orders')
        .insert({
  user_id: auth.user.id,
  customer_name: customerData.name,
  customer_email: customerData.email,

  cep: customerData.cep,
  rua: customerData.rua,
  numero: customerData.numero,
  complemento: customerData.complemento || null,
  bairro: customerData.bairro,
  cidade: customerData.cidade,
  estado: customerData.estado,

  total,
  subtotal:pricing.subtotal,
  shipping_amount:pricing.shipping_amount,
  shipping_region:pricing.shipping_region,
  discount_amount:0,
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

    const mpResponse = await paymentFetch(
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
      ...pricing,

      qr_code:
        transactionData.qr_code,

      qr_code_base64:
        transactionData.qr_code_base64
    });

  } catch (error) {
    console.error('Erro create-checkout:', error);

    return res.status(error.status||500).json({error:error.status?error.message:'Erro ao gerar pagamento Pix.'});
  }
}

}
let defaultHandler;
export default async function checkout(req,res){
 defaultHandler ||= createCheckoutHandler(createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}));
 return defaultHandler(req,res);
}
