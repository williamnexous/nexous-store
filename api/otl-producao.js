import { createHash, timingSafeEqual } from 'node:crypto';

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXOUS — Importar OTL</title>
<style>
body{
  background:#111;
  color:#eee;
  font:16px Arial;
  margin:0;
  padding:24px;
}
main{
  max-width:700px;
  margin:auto;
}
p{
  line-height:1.6;
}
input,button{
  font:inherit;
  padding:16px;
  box-sizing:border-box;
  width:100%;
  margin:10px 0;
  border-radius:8px;
}
input{
  background:#222;
  color:#fff;
  border:1px solid #555;
}
button{
  background:#d7ff57;
  border:0;
}
button:disabled{
  opacity:.5;
}
</style>
</head>
<body>
<main>
<h1>NEXOUS / catálogo OTL</h1>

<p>
Importação de produção.
Preço de venda: atacado + 40%.
Os produtos ficam desativados enquanto ajustamos o checkout.
Nenhum pedido é enviado à OTL.
</p>

<form id="form">
<label>
Senha de importação
<input
  id="secret"
  type="password"
  minlength="32"
  required
  autocomplete="off"
>
</label>
<button id="start">IMPORTAR PRODUTOS</button>
</form>

<p id="status" role="status" aria-live="polite"></p>
</main>

<script>
const form=document.getElementById('form');
const button=document.getElementById('start');
const status=document.getElementById('status');

form.onsubmit=async e=>{
  e.preventDefault();

  if(button.disabled)return;

  button.disabled=true;

  const field=document.getElementById('secret');
  const secret=field.value;

  field.value='';

  let cursor=null;
  let total=0;

  const seen=new Set();

  try{
    for(let page=0;page<1000;page++){
      status.textContent=
        'Importando página '+(page+1)+
        '… '+total+' produtos confirmados.';

      const response=await fetch(location.pathname,{
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'X-Import-Secret':secret
        },
        body:JSON.stringify({cursor}),
        signal:AbortSignal.timeout(15000)
      });

      const data=await response.json();

      if(!response.ok){
        throw new Error(data.erro||'Falha na importação.');
      }

      total+=data.quantidade;

      if(!data.temMais){
        status.textContent=
          'Concluído: '+total+' produtos processados. '+
          'Salvos desativados, com atacado + 40%. '+
          'A atualização automática ainda não está configurada.';
        return;
      }

      if(
        !data.proximoCursor||
        seen.has(data.proximoCursor)
      ){
        throw new Error('Paginação inválida.');
      }

      cursor=data.proximoCursor;
      seen.add(cursor);

      await new Promise(resolve=>setTimeout(resolve,2200));
    }

    throw new Error('Limite de páginas atingido.');
  }catch(error){
    status.textContent=
      error.message+' '+total+' produtos já confirmados. '+
      'Pode repetir: os mesmos SKUs serão atualizados.';
  }finally{
    button.disabled=false;
  }
};
</script>
</body>
</html>`;

function wholesaleCents(value) {
  const raw = String(value ?? '');

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error('Preço inválido');
  }

  const cents = Math.round(Number(raw) * 100);

  if (
    !Number.isSafeInteger(cents) ||
    cents <= 0 ||
    cents > 100000000
  ) {
    throw new Error('Preço inválido');
  }

  return cents;
}

export function mapProduct(p, timestamp) {
  if (
    typeof p.sku !== 'string' ||
    !p.sku.trim() ||
    typeof p.titulo !== 'string' ||
    !p.titulo.trim() ||
    typeof p.ativo !== 'boolean' ||
    !Array.isArray(p.numeracoes)
  ) {
    throw new Error('Produto inválido');
  }

  const numeracoes = p.numeracoes.map(n => {
    if (
      typeof n.numeracao !== 'string' ||
      !n.numeracao.trim() ||
      !(
        n.estoque === null ||
        Number.isSafeInteger(n.estoque) && n.estoque >= 0
      )
    ) {
      throw new Error('Estoque inválido');
    }

    return {
      numeracao: n.numeracao,
      skuVariacao: n.skuVariacao ?? null,
      estoque: n.estoque
    };
  });

  if (
    new Set(numeracoes.map(n => n.numeracao)).size !==
    numeracoes.length
  ) {
    throw new Error('Numeração repetida');
  }

  const name = p.titulo.trim();

  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const brands = [
    ['nike', 'Nike'],
    ['lacoste', 'Lacoste'],
    ['adidas', 'Adidas'],
    ['all star', 'All Star'],
    ['converse', 'All Star'],
    ['puma', 'Puma'],
    ['new balance', 'New Balance']
  ];

  const category = /chuteira/.test(normalized)
    ? 'Chuteiras'
    : /chinelo|slide|sandalia/.test(normalized)
      ? 'Chinelos'
      : brands.find(([key]) => normalized.includes(key))?.[1]
        || 'Tênis';

  const stock = numeracoes.reduce(
    (sum, n) => sum + (n.estoque ?? 0),
    0
  );

  if (
    !Number.isSafeInteger(stock) ||
    stock > 2147483647
  ) {
    throw new Error('Estoque inválido');
  }

  const sellCents = Math.round(
    wholesaleCents(p.precoAtacado) * 140 / 100
  );

  return {
    otl_sku: p.sku.trim(),
    name,
    price: sellCents / 100,

    image_url:
      typeof p.imagem === 'string' &&
      /^https:\/\//.test(p.imagem)
        ? p.imagem
        : null,

    product_type: 'tenis',
    category,

    sizes: numeracoes
      .filter(n =>
        p.ativo &&
        n.estoque !== null &&
        n.estoque > 0
      )
      .map(n => n.numeracao),

    stock: p.ativo ? stock : 0,

    otl_stock: numeracoes,
    otl_synced_at: timestamp,

    active: false
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (process.env.VERCEL_ENV !== 'production') {
    return res.status(404).end();
  }

  if (req.method === 'GET') {
    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    return res.status(200).send(PAGE);
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');

    return res.status(405).json({
      erro: 'Método não permitido.'
    });
  }

  const secret = process.env.OTL_SYNC_SECRET;
  const supplied = req.headers['x-import-secret'];

  if (!secret || secret.length < 32) {
    return res.status(500).json({
      erro:
        'Configure OTL_SYNC_SECRET com pelo menos ' +
        '32 caracteres em Produção.'
    });
  }

  const hash = value =>
    createHash('sha256').update(value).digest();

  if (
    typeof supplied !== 'string' ||
    supplied.length > 1024 ||
    !timingSafeEqual(hash(secret), hash(supplied))
  ) {
    return res.status(401).json({
      erro: 'Senha de importação incorreta.'
    });
  }

  const token = process.env.OTL_API_TOKEN?.trim();

  const db = (
    process.env.SUPABASE_URL ||
    process.env.URL_SUPABASE ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (
    !token?.startsWith('otl_prod_') ||
    db !== 'https://tcszjspirwwxrkabhtgi.supabase.co' ||
    !key
  ) {
    return res.status(500).json({
      erro:
        'Confira OTL_API_TOKEN, SUPABASE_URL e ' +
        'SUPABASE_SERVICE_ROLE_KEY em Produção.'
    });
  }

  const cursor = req.body?.cursor;

  if (
    cursor != null &&
    (
      typeof cursor !== 'string' ||
      !cursor ||
      cursor.length > 4096
    )
  ) {
    return res.status(400).json({
      erro: 'Cursor inválido.'
    });
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    8000
  );

  try {
    const url = new URL(
      'https://api.otlshoes.com.br/v1/produtos'
    );

    url.searchParams.set('limite', '50');

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token
      },
      signal: controller.signal,
      redirect: 'error'
    });

    if (!response.ok) {
      return res.status(502).json({
        erro: 'Falha na consulta à OTL.',
        statusOTL: response.status
      });
    }

    const data = await response.json();
    const paging = data.paginacao;

    if (
      !Array.isArray(data.dados) ||
      data.dados.length > 50 ||
      typeof paging?.temMais !== 'boolean' ||
      (
        paging.temMais &&
        (
          typeof paging.proximoCursor !== 'string' ||
          !paging.proximoCursor ||
          paging.proximoCursor.length > 4096 ||
          paging.proximoCursor === cursor
        )
      )
    ) {
      throw new Error('Resposta inválida');
    }

    const rows = [
      ...new Map(
        data.dados.map(p => {
          const row = mapProduct(
            p,
            new Date().toISOString()
          );

          return [row.otl_sku, row];
        })
      ).values()
    ];

    if (rows.length) {
      const saved = await fetch(
        db + '/rest/v1/products?on_conflict=otl_sku',
        {
          method: 'POST',

          headers: {
            apikey: key,
            Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json',
            Prefer:
              'resolution=merge-duplicates,return=minimal'
          },

          body: JSON.stringify(rows),
          signal: controller.signal,
          redirect: 'error'
        }
      );

      if (!saved.ok) {
        return res.status(502).json({
          erro:
            'Falha ao salvar os produtos. Confira as ' +
            'colunas novas na tabela products.',
          statusBanco: saved.status
        });
      }
    }

    return res.status(200).json({
      quantidade: rows.length,
      temMais: paging.temMais,
      proximoCursor: paging.temMais
        ? paging.proximoCursor
        : null
    });

  } catch {
    return res.status(502).json({
      erro:
        'Consulta ou gravação não concluída. ' +
        'Confira a configuração e tente novamente.'
    });

  } finally {
    clearTimeout(timer);
  }
}
