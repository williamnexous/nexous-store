import {createClient} from '@supabase/supabase-js';
import {catalogSubtotal,lookupCep,totalsForRegion} from '../frete-utils.js';
export function createFreteHandler(sb,lookup=lookupCep){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Método não permitido.'});
  try{
   const subtotal=await catalogSubtotal(sb,req.body?.items);
   const destination=await lookup(req.body?.cep);
   return res.status(200).json({...totalsForRegion(subtotal,destination.uf),destination});
  }catch(error){return res.status(error.status||500).json({error:error.status?error.message:'Não foi possível calcular o frete.'});}
 };
}
let handler;
export default async function frete(req,res){
 handler ||= createFreteHandler(createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}));
 return handler(req,res);
}
