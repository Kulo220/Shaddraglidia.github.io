// =====================================================================
// Offres entre utilisateurs (donner ou vendre une carte de sa collection
// à quelqu'un qui la cherche dans sa wishlist)
//
// Le site ne gère AUCUN paiement : quand une offre est acceptée, les deux
// personnes s'arrangent en privé.
// =====================================================================

import { supabase } from './config.js';
import { fetchAll, friendlyError, CARD_COLUMNS } from './common.js?v=19';

// Prix affiché : « 4,50 € », « 3,00 $ »
export function formatOfferPrice(price, currency) {
  const code = currency === 'USD' ? 'USD' : 'EUR';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).format(Number(price));
}

// Message clair pour une erreur d'envoi
function sendError(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`;
  if (/23505/.test(text)) return 'Tu as déjà une offre en attente pour cette carte à cette personne.';
  if (/42501/.test(text) && !/PGRST205|42P01/.test(text)) {
    return "Impossible d'envoyer cette offre : tu ne possèdes plus assez d'exemplaires, ou cette personne ne cherche plus cette carte.";
  }
  if (/23514/.test(text)) return 'Prix ou quantité invalide.';
  return friendlyError(error);
}

// Envoie une offre. kind : 'gift' | 'sale' (prix et devise obligatoires pour une vente)
export async function createOffer({ toUser, cardId, kind, price, currency, quantity, message }) {
  const row = { to_user: toUser, card_id: cardId, kind, quantity, message: message || null };
  if (kind === 'sale') {
    row.price = price;
    row.currency = currency;
  }
  const { data, error } = await supabase
    .from('offers')
    .insert(row)
    .select('id, to_user, card_id, kind, price, currency, quantity, status, created_at')
    .single();
  if (error) {
    const err = new Error(sendError(error));
    err.friendly = true;
    throw err;
  }
  return data;
}

// Tes offres envoyées, la plus récente par (destinataire, carte) : Map « userId:cardId » -> offre
export async function loadSentOffers(userId) {
  const rows = await fetchAll(() =>
    supabase.from('offers').select('id, to_user, card_id, kind, price, currency, status, created_at').eq('from_user', userId),
  );
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.to_user}:${row.card_id}`;
    const known = latest.get(key);
    if (!known || String(row.created_at) > String(known.created_at)) latest.set(key, row);
  }
  return latest;
}

// Les offres d'un côté : 'received' (à toi) ou 'sent' (de toi), avec la carte
export async function loadOffers(side, userId) {
  const column = side === 'received' ? 'to_user' : 'from_user';
  const columns = `id, from_user, to_user, kind, price, currency, quantity, message, status, to_seen, from_seen, created_at, responded_at, cards!inner(${CARD_COLUMNS})`;
  const rows = await fetchAll(() => supabase.from('offers').select(columns).eq(column, userId));
  const rank = { pending: 0, accepted: 1, declined: 2, cancelled: 3 };
  return rows
    .map((r) => ({ ...r, card: r.cards }))
    .sort((a, b) => rank[a.status] - rank[b.status] || String(b.created_at).localeCompare(String(a.created_at)));
}

// Accepter / refuser (destinataire) ou annuler (auteur) une offre en attente
export async function answerOffer(id, status) {
  const { data, error } = await supabase
    .from('offers')
    .update({ status })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id, status');
  if (error) throw error;
  if (!data?.length) throw new Error("Cette offre n'est plus en attente.");
}

// Marque des offres comme vues : côté 'received' (to_seen) ou 'sent' (from_seen)
export async function markSeen(side, ids) {
  if (!ids.length) return;
  const patch = side === 'received' ? { to_seen: true } : { from_seen: true };
  const { error } = await supabase.from('offers').update(patch).in('id', ids);
  if (error) throw error;
}
