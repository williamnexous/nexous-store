import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { lookupCep, totalsForRegion } from '../frete-utils.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const cents = value => {
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('Preço inválido.', 409);
  return amount;
};

export async function checkOtlStock(products, items, otlFetch = fetch) {
  const imported = products.filter(p => p.otl_sku);
  if (!imported.length) return;
  const token = process.env.OTL_API_TOKEN?.trim();
  if (!token?.startsWith('otl_prod_')) throw fail('Não foi possível conferir o estoque. Tente novamente mais tarde.', 503);
  if (imported.length > 10) throw fail('Finalize até 10 modelos da OTL por compra. Divida o carrinho em duas compras.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  const live = new Map();
  try {
    // Três consultas simultâneas, dentro do tempo da função.
    for (let start = 0; start < imported.length; start += 3) {
      await Promise.all(imported.slice(start, start + 3).map(async product => {
        const url = new URL('https://api.otlshoes.com.br/v1/produtos');
        url.searchParams.set('busca', product.otl_sku);
        url.searchParams.set('limite', '100');
        const response = await otlFetch(url, {
          headers: { Authorization: 'Bearer ' + token },
          signal: controller.signal,
          redirect: 'error'
        });
        if (!response.ok) throw fail('A consulta de estoque está indisponível. Tente novamente em instantes.', 503);
        const data = await response.json();
        if (!Array.isArray(data.dados)) throw fail('Não foi possível confirmar o estoque.', 503);
        const matches = data.dados.filter(p => p.sku === product.otl_sku);
        if (matches.length !== 1 || matches[0].ativo !== true) throw fail('Um produto não está mais disponível. Atualize o carrinho.', 409);
        const current = matches[0];
        if (!Array.isArray(current.numeracoes)) throw fail('Não foi possível confirmar as numerações.', 503);
        const rawPrice = String(current.precoAtacado ?? '');
        if (!/^\d+(\.\d{1,2})?$/.test(rawPrice)) throw fail('Não foi possível confirmar o preço.', 503);
        const wholesale = cents(rawPrice);
        const sale = Math.round(wholesale * 170 / 100);
        if (sale !== cents(product.price)) throw fail('O preço de um produto mudou. Aguarde a atualização do catálogo antes de comprar.', 409);
        live.set(String(product.id), current);
      }));
    }
    for (const item of items) {
      const current = live.get(String(item.product_id));
      if (!current) continue;
      const sizes = current.numeracoes.filter(n => n.numeracao === item.size);
      if (sizes.length !== 1 || !Number.isSafeInteger(sizes[0].estoque) || sizes[0].estoque < item.quantity) {
        throw fail(`Estoque insuficiente ou não confirmado para ${item.product_name}, número ${item.size}. Atualize o carrinho.`, 409);
      }
    }
  } catch (error) {
    if (error.status) throw error;
    throw fail('Não foi possível consultar o estoque da OTL. Tente novamente em instantes.', 503);
  } finally {
    clearTimeout(timer);
  }
}

export function createCheckoutHandler(supabase, paymentFetch = fetch, cepLookup = lookupCep, otlFetch = fetch) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    try {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw fail('Entre na sua conta para comprar e acompanhar o pedido.', 401);
      const { data: auth, error: authError } = await supabase.auth.getUser(token);
      if (authError || !auth?.user) throw fail('Entre novamente na sua conta.', 401);
      if (!auth.user.email_confirmed_at) throw fail('Confirme seu e-mail antes de comprar.', 403);
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
      if (['cep', 'rua', 'numero', 'bairro', 'cidade', 'estado'].some(field => !customerData[field])) throw fail('Preencha todos os campos obrigatórios do endereço.');
      if (customerData.cep.length !== 8) throw fail('CEP inválido.');
      if (!/^[A-Z]{2}$/.test(customerData.estado)) throw fail('Estado inválido. Use a sigla, por exemplo: RS.');
      if (!customerData.name || !customerData.email || !customerData.cpf) throw fail('Nome, e-mail e CPF são obrigatórios!');
      if (customerData.cpf.length !== 11) throw fail('CPF inválido.');
      if (!Array.isArray(items) || !items.length || items.length > 50) throw fail('Carrinho vazio ou com muitos itens.');
      const ids = [...new Set(items.map(item => item?.product_id || item?.id))];
      if (ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw fail('Produto inválido no carrinho.');
      const { data: products, error: productsError } = await supabase.from('products')
        .select('id,name,price,product_type,sizes,category,stock,otl_sku,otl_stock')
        .in('id', ids).eq('active', true);
      if (productsError) throw productsError;
      if (!products || products.length !== ids.length) throw fail('Um ou mais produtos não estão disponíveis.');
      const productMap = new Map(products.map(p => [String(p.id).toLowerCase(), p]));
      const grouped = new Map();
      for (const item of items) {
        const product = productMap.get(String(item.product_id || item.id).toLowerCase());
        if (!product) throw fail('Produto inválido.');
        if (!['Nike', 'Lacoste', 'Adidas', 'All Star', 'Puma', 'New Balance', 'Chuteiras', 'Chinelos', 'Tênis'].includes(product.category)) throw fail('Este produto não faz parte do catálogo atual.');
        const quantity = Number(item.quantity);
        const size = String(item.size || (product.product_type === 'acessorio' ? 'Único' : '')).trim();
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw fail('Quantidade inválida.');
        const validSizes = product.otl_sku
          ? Array.isArray(product.otl_stock) ? product.otl_stock.map(n => String(n.numeracao)) : []
          : product.product_type === 'acessorio' ? ['Único']
            : Array.isArray(product.sizes) && product.sizes.length ? product.sizes.map(String)
              : product.product_type === 'tenis' ? ['38', '39', '40', '41', '42'] : ['P', 'M', 'G', 'GG'];
        if (!validSizes.includes(size)) throw fail(`Tamanho inválido para ${product.name}.`);
        const key = JSON.stringify([product.id, size]);
        const previous = grouped.get(key);
        const combined = (previous?.quantity || 0) + quantity;
        if (combined > 10) throw fail('O limite é de 10 unidades por produto e numeração.');
        grouped.set(key, { product_id: product.id, product_name: product.name, size, quantity: combined, unit_price: cents(product.price) / 100 });
      }
      const orderItems = [...grouped.values()];
      // Produtos manuais usam o estoque total já cadastrado.
      for (const product of products.filter(p => !p.otl_sku)) {
        const quantity = orderItems.filter(i => i.product_id === product.id).reduce((sum, i) => sum + i.quantity, 0);
        if (product.stock != null && (!Number.isInteger(product.stock) || product.stock < quantity)) throw fail(`Estoque insuficiente para ${product.name}.`, 409);
      }
      const subtotalCents = orderItems.reduce((sum, item) => sum + cents(item.unit_price) * item.quantity, 0);
      const destination = await cepLookup(customerData.cep);
      if (destination.uf !== customerData.estado) throw fail('O estado informado não corresponde ao CEP. Calcule o frete novamente.');
      const pricing = totalsForRegion(subtotalCents, destination.uf);
      if (!Number.isFinite(Number(expected_total)) || Math.round(Number(expected_total) * 100) !== Math.round(pricing.total * 100)) {
        return res.status(409).json({ error: 'O valor da compra mudou. Calcule o frete novamente antes de gerar o Pix.', pricing });
      }
      if (!process.env.MP_ACCESS_TOKEN) throw fail('O pagamento está temporariamente indisponível.', 503);
      // Consulta real antes de criar o pedido e o pagamento.
      await checkOtlStock(products, orderItems, otlFetch);
      const { data: order, error: orderError } = await supabase.from('orders').insert({
        user_id: auth.user.id, customer_name: customerData.name, customer_email: customerData.email,
        cep: customerData.cep, rua: customerData.rua, numero: customerData.numero,
        complemento: customerData.complemento || null, bairro: customerData.bairro,
        cidade: customerData.cidade, estado: customerData.estado,
        total: pricing.total, subtotal: pricing.subtotal, shipping_amount: pricing.shipping_amount,
        shipping_region: pricing.shipping_region, discount_amount: 0, status: 'pending'
      }).select().single();
      if (orderError) throw orderError;
      const { error: itemsError } = await supabase.from('order_items').insert(orderItems.map(item => ({ ...item, order_id: order.id })));
      if (itemsError) throw itemsError;
      const paymentBody = {
        transaction_amount: pricing.total, description: `Pedido NEXOUS ${order.id}`, payment_method_id: 'pix',
        payer: { email: customerData.email, first_name: customerData.name, identification: { type: 'CPF', number: customerData.cpf } },
        external_reference: String(order.id),
        notification_url: 'https://nexous-store.vercel.app/api/mercadopago-webhook'
      };
      const mpResponse = await paymentFetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST', headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'X-Idempotency-Key': crypto.randomUUID()
        }, body: JSON.stringify(paymentBody)
      });
      const payment = await mpResponse.json();
      if (!mpResponse.ok) {
        console.error('Mercado Pago: falha ao criar Pix, status', mpResponse.status);
        return res.status(400).json({ error: 'Não foi possível gerar o Pix.' });
      }
      const { error: updateError } = await supabase.from('orders').update({ payment_id: String(payment.id), status: payment.status || 'pending' }).eq('id', order.id);
      if (updateError) console.error('Falha ao vincular pagamento ao pedido', order.id);
      const transactionData = payment.point_of_interaction?.transaction_data;
      if (!transactionData?.qr_code || !transactionData?.qr_code_base64) throw fail('O Mercado Pago não retornou o QR Code do Pix.', 502);
      return res.status(200).json({ order_id: order.id, payment_id: String(payment.id), status: payment.status, ...pricing,
        qr_code: transactionData.qr_code, qr_code_base64: transactionData.qr_code_base64 });
    } catch (error) {
      if (!error.status) console.error('create-checkout: falha interna', error.code || error.name);
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Erro ao gerar pagamento Pix.' });
    }
  };
}

let defaultHandler;
export default async function checkout(req, res) {
  defaultHandler ||= createCheckoutHandler(createClient(
    process.env.SUPABASE_URL || process.env.URL_SUPABASE,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  ));
  return defaultHandler(req, res);
}
