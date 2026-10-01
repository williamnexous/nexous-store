import { createClient } from '@supabase/supabase-js';

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
    const { items, customer, customer_name, customer_email, customer_cpf } = req.body;

const customerData = {
  name: customer?.name || customer_name || '',
  email: customer?.email || customer_email || '',
  cpf: customer?.cpf || ''
};

if (!customerData.name || !customerData.email || !customerData.cpf) {
  return res.status(400).json({
    error: 'Nome, e-mail e CPF são obrigatórios!'
  });
}
    if (!items || !items.length) {
      return res.status(400).json({
        error: 'Carrinho vazio'
      });
    }

    // Buscar produtos reais no Supabase
const ids = items.map(item => item.product_id || item.id);

if (ids.some(id => !id)) {
  return res.status(400).json({
    error: 'ID do produto não encontrado no carrinho'
  });
}

    const { data: products, error } = await supabase
      .from('products')
     .select('id,name,price,product_type')
      .in('id', ids)
      .eq('active', true);

    if (error) {
      throw error;
    }

    if (!products || products.length === 0) {
      return res.status(400).json({
        error: 'Produtos não encontrados'
      });
    }


    let total = 0;

const productMap = new Map(
  products.map(product => [product.id, product])
);

const orderItems = items.map(item => {
  const product = productMap.get(item.product_id || item.id);

  if(!product){
    throw new Error('Produto inválido');
  }

  const quantity = Math.max(1, Number(item.quantity) || 1);
  const size = String(item.size || '');

  const validSizes = product.product_type === 'tenis'
    ? ['38','39','40','41','42']
    : ['P','M','G'];

  if(!validSizes.includes(size)){
    throw new Error('Tamanho inválido para ' + product.name);
  }

  total += Number(product.price) * quantity;

  return {
    product_id: product.id,
    product_name: product.name,
    size,
    quantity,
    unit_price: product.price
  };
});


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


    // Salvar itens do pedido
    await supabase
      .from('order_items')
      .insert(
        orderItems.map(item => ({
          ...item,
          order_id: order.id
        }))
      );


    // Criar preferência Mercado Pago

    const preference = {

      items: orderItems.map(item => ({
        title: `${item.product_name} - ${item.size}`,
        quantity: item.quantity,
        unit_price: Number(item.unit_price)
      })),

      external_reference: order.id,

      back_urls: {
  success: "https://nexous-store.vercel.app/sucesso.html",
  failure: "https://nexous-store.vercel.app/falha.html",
  pending: "https://nexous-store.vercel.app/pendente.html"
},

      auto_return: "approved"

    };


    const response = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {

        method: "POST",

        headers: {

          "Content-Type": "application/json",

          "Authorization":
          `Bearer ${process.env.MP_ACCESS_TOKEN}`

        },

        body: JSON.stringify(preference)

      }
    );


    const data = await response.json();


    if (!response.ok) {

      throw data;

    }


    // guardar id do pagamento

    await supabase
      .from('orders')
      .update({

        payment_id: data.id

      })
      .eq(
        'id',
        order.id
      );


    return res.status(200).json({

      checkout_url:
      data.init_point

    });


  } catch (error) {

    console.error(error);

    return res.status(500).json({

      error:
      "Erro ao criar checkout"

    });

  }

}
