import { createClient } from '@supabase/supabase-js';

export const deliveryStages = ['aguardando','preparando','enviado','em_transito','entregue'];
const fields = 'id,user_id,customer_name,customer_email,total,status,created_at,cep,rua,numero,complemento,bairro,cidade,estado,delivery_status,carrier,tracking_code,tracking_url,estimated_delivery,delivery_note,delivery_updated_at';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateDelivery(input) {
  if (!deliveryStages.includes(input.delivery_status)) throw new Error('Etapa de entrega inválida.');
  const out = { delivery_status: input.delivery_status };
  for (const [key,max] of Object.entries({carrier:100,tracking_code:120,tracking_url:1000,delivery_note:1000})) {
    if (typeof input[key] !== 'string' || input[key].length > max) throw new Error('Campo inválido: '+key);
    out[key] = input[key].trim();
  }
  if (out.tracking_url) {
    let url; try { url = new URL(out.tracking_url); } catch { throw new Error('Link de rastreamento inválido.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use um link de rastreamento HTTPS.');
    out.tracking_url = url.href;
  }
  const date = input.estimated_delivery;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)) throw new Error('Data prevista inválida.');
  out.estimated_delivery = date || null;
  return out;
}
export function createOrdersHandler(sb) {
  return async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if (!['GET','PATCH'].includes(req.method)) return res.status(405).json({error:'Método não permitido.'});
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({error:'Entre na sua conta.'});
    try {
      const {data:auth,error:authError} = await sb.auth.getUser(token);
      const user = auth?.user;
      if (authError || !user) return res.status(401).json({error:'Sessão inválida. Entre novamente.'});
      const {data:admin,error:adminError} = await sb.from('admins').select('user_id').eq('user_id',user.id).maybeSingle();
      if (adminError) throw adminError;
      const adminMode = req.query?.scope === 'admin';
      if ((adminMode || req.method === 'PATCH') && !admin) return res.status(403).json({error:'Acesso restrito ao administrador.'});
      if (req.method === 'GET') {
        const rawOffset = req.query?.offset ?? '0';
        if (!/^\d+$/.test(String(rawOffset)) || Number(rawOffset)>100000) return res.status(400).json({error:'Página inválida.'});
        const offset = Number(rawOffset);
        let query = sb.from('orders').select(fields).order('created_at',{ascending:false}).range(offset,offset+49);
        if (!adminMode) {
          // New purchases are bound to a verified account ID. Legacy orders are
          // available only to the owner of their confirmed email address.
          const email = user.email;
          if (user.email_confirmed_at && email && /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9.-]+$/.test(email)) {
            query = query.or(`user_id.eq.${user.id},and(user_id.is.null,customer_email.eq.${email})`);
          } else query = query.eq('user_id',user.id);
        }
        const {data:orders,error} = await query;
        if (error) throw error;
        const ids = (orders||[]).map(o=>o.id);
        let items = [];
        if (ids.length) {
          const result = await sb.from('order_items').select('order_id,product_name,size,quantity,unit_price').in('order_id',ids);
          if (result.error) throw result.error;
          items = result.data||[];
        }
        return res.status(200).json({orders:(orders||[]).map(o=>({...o,items:items.filter(i=>i.order_id===o.id)})),next_offset:orders?.length===50?offset+50:null});
      }
      const input = req.body || {};
      if (!uuid.test(input.id||'')) return res.status(400).json({error:'Pedido inválido.'});
      let values;
      try { values = validateDelivery(input); } catch (e) { return res.status(400).json({error:e.message}); }
      const {data:order,error:findError} = await sb.from('orders').select('id,status,delivery_updated_at').eq('id',input.id).maybeSingle();
      if (findError) throw findError;
      if (!order) return res.status(404).json({error:'Pedido não encontrado.'});
      if (!['pago','approved'].includes(order.status) && values.delivery_status !== 'aguardando') return res.status(409).json({error:'O pagamento precisa estar aprovado antes de avançar a entrega.'});
      if ((input.delivery_updated_at||null)!==(order.delivery_updated_at||null)) return res.status(409).json({error:'Este pedido foi alterado. Atualize a lista antes de salvar.'});
      values.delivery_updated_at = new Date().toISOString();
      let update = sb.from('orders').update(values).eq('id',order.id);
      update = order.delivery_updated_at ? update.eq('delivery_updated_at',order.delivery_updated_at) : update.is('delivery_updated_at',null);
      const {data:saved,error:saveError} = await update.select(fields).maybeSingle();
      if (saveError) throw saveError;
      if (!saved) return res.status(409).json({error:'Este pedido foi alterado. Atualize a lista.'});
      return res.status(200).json({order:saved});
    } catch (e) {
      console.error('orders:',e.code||e.message);
      return res.status(500).json({error:'Não foi possível acessar os pedidos. Confira a instalação e tente novamente.'});
    }
  };
}
let handler;
export default async function orders(req,res) {
  if (!handler) handler=createOrdersHandler(createClient(process.env.SUPABASE_URL||process.env.URL_SUPABASE,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}));
  return handler(req,res);
}
