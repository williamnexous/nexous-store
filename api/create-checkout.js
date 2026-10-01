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
    const { items, customer } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({
        error: 'Carrinho vazio'
      });
    }

    // Buscar produtos reais no // Buscar produtos reais no Supabase
const ids = items.map(item => item.product_id || item.id);

if (ids.some(id => !id)) {
  return res.status(400).json({
    error: 'ID do produto não encontrado no carrinho'
  });
}

    const { data: products, error } = await supabase
      .from('products')
      .select('id,name,price')
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

    const orderItems = products.map(product => {

      const item = items.find(
  i => (i.product_id || i.id) === product.id
);

      const quantity = item?.quantity || 1;

      total += Number(product.price) * quantity;

      return {
        product_id: product.id,
        product_name: product.name,
        quantity,
        unit_price: product.price
      };

    });


    // Criar pedido pendente
    const { data: order, error: orderError } =
      await supabase
      .from('orders')
      .insert({
        customer_name: customer.name,
        customer_email: customer.email,
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
        title: item.product_name,
        quantity: item.quantity,
        unit_price: Number(item.unit_price)
      })),

      external_reference: order.id,

      back_urls: {
        success: "https://SEU-SITE.vercel.app/sucesso.html",
        failure: "https://SEU-SITE.vercel.app/falha.html",
        pending: "https://SEU-SITE.vercel.app/pendente.html"
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
