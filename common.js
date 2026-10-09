// =====================================================================
// Éléments communs aux pages (collection, wishlist, decks)
// =====================================================================

import { supabase } from './config.js';
import { getGame } from './games.js?v=19';

// Affichage des images des cartes, directement depuis le serveur de l'API.
// Passe à false pour tout désactiver d'un coup (ex. si l'API bloque les images).
export const SHOW_IMAGES = true;

export const CARD_COLUMNS = 'id, game, external_id, name, card_type, image_url, data, set_code, set_name, rarity';

// ---------- Petits utilitaires ----------

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent : jamais de HTML venant d'une API
  return node;
}

export const normalize = (s) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

// Une carte = un jeu + son identifiant (deux jeux pourraient avoir le même identifiant)
export const keyOf = (card) => `${card.game}:${card.external_id}`;
export const providerOf = (card) => getGame(card.game)?.provider ?? null;

export function friendlyError(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  if (/card_prices/i.test(text)) {
    return "La base n'est pas à jour : exécute prices_v1.sql dans le SQL Editor de Supabase.";
  }
  if (/\boffers\b/i.test(text) && /PGRST205|42P01|does not exist|schema cache/i.test(text)) {
    return "La base n'est pas à jour : exécute offers_v1.sql dans le SQL Editor de Supabase.";
  }
  if (/collection_public/i.test(text)) {
    return "La base n'est pas à jour : exécute collection_share_v1.sql dans le SQL Editor de Supabase.";
  }
  if (/deck_cards|"?decks"?|PGRST205.*deck|42P01.*deck/i.test(text)) {
    return "La base n'est pas à jour : exécute decks_v1.sql dans le SQL Editor de Supabase.";
  }
  if (/wishlist_items|PGRST205|42P01/i.test(text)) {
    return "La base n'est pas à jour : exécute wishlist_v1.sql dans le SQL Editor de Supabase.";
  }
  if (/PGRST204|42703|card_type|does not exist/i.test(text)) {
    return "La base n'est pas à jour : exécute collection_v2.sql dans le SQL Editor de Supabase.";
  }
  if (/row-level security|42501/i.test(text)) {
    return "La base refuse l'opération (droits). Vérifie que les scripts SQL ont bien été exécutés.";
  }
  return `Une erreur est survenue : ${err?.message ?? 'inconnue'}`;
}

// Supabase renvoie 1000 lignes au maximum par requête : on lit par paquets
export async function fetchAll(makeQuery) {
  const rows = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await makeQuery().order('id').range(from, from + step - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < step) break;
  }
  return rows;
}

// ---------- Catalogue partagé ----------

// Retrouve la carte dans le catalogue partagé, ou l'y ajoute.
// Renvoie la ligne enregistrée (avec son id).
export async function ensureCard(card) {
  const find = () =>
    supabase
      .from('cards')
      .select(CARD_COLUMNS)
      .eq('game', card.game)
      .eq('external_id', card.external_id)
      .maybeSingle();

  let { data, error } = await find();
  if (error) throw error;
  if (data) return data;

  // Le jeu peut compléter la fiche avant l'enregistrement
  // (ex. Pokémon : la recherche ne donne ni type, ni PV, ni rareté)
  const provider = getGame(card.game)?.provider;
  const full = (await provider?.enrich?.(card)) ?? card;

  const inserted = await supabase
    .from('cards')
    .insert({
      game: full.game,
      external_id: full.external_id,
      name: full.name,
      card_type: full.card_type,
      set_code: full.set_code ?? null,
      set_name: full.set_name ?? null,
      rarity: full.rarity ?? null,
      image_url: full.image_url,
      data: full.data,
      source: 'api',
    })
    .select(CARD_COLUMNS)
    .single();
  if (!inserted.error) return inserted.data;

  // Quelqu'un vient de l'ajouter en même temps : on la relit
  if (inserted.error.code === '23505') {
    ({ data, error } = await find());
    if (data) return data;
  }
  throw inserted.error;
}

// ---------- Miniatures et image en grand ----------

export function createImages({ lightbox, img, name, meta, onError }) {
  // Chargement paresseux : une image n'est demandée que lorsqu'elle est
  // proche de l'écran (moins de requêtes vers le serveur de l'API).
  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              observer.unobserve(entry.target);
              entry.target.src = entry.target.dataset.src;
            }
          },
          { rootMargin: '300px 0px' },
        )
      : null;

  let token = 0;

  function show(card, thumbImg) {
    if (!lightbox || typeof lightbox.showModal !== 'function') {
      throw new Error("Fenêtre d'agrandissement indisponible (page à mettre à jour ?)");
    }
    const provider = providerOf(card);
    const thumbSrc = thumbImg.currentSrc || thumbImg.src;
    const wanted = ++token;

    img.classList.toggle('is-landscape', thumbImg.naturalWidth > thumbImg.naturalHeight);
    img.alt = card.name;
    name.textContent = card.name;
    meta.textContent = provider?.metaLine?.(card) ?? '';

    // 1) tout de suite : la miniature déjà chargée (floue mais instantanée)
    if (thumbSrc) img.src = thumbSrc;
    else img.removeAttribute('src');
    if (!lightbox.open) lightbox.showModal();

    // 2) puis la grande version (sinon l'image d'origine), remplacée dès qu'elle est prête
    const candidates = [...new Set([provider?.fullUrl?.(card.image_url) ?? card.image_url, card.image_url])].filter(
      (url) => url && url !== thumbSrc && /^https:\/\//.test(url),
    );
    const tryNext = () => {
      const url = candidates.shift();
      if (!url) {
        if (!thumbSrc && wanted === token) {
          lightbox.close();
          onError?.('Impossible de charger cette image.');
        }
        return;
      }
      const loader = new Image();
      loader.onload = () => {
        if (wanted === token && lightbox.open) img.src = url;
      };
      loader.onerror = tryNext;
      loader.src = url;
    };
    tryNext();
  }

  function open(card, thumbImg) {
    try {
      show(card, thumbImg);
    } catch (err) {
      // Filet de sécurité : si la fenêtre ne peut pas s'ouvrir, l'image s'ouvre dans un nouvel onglet
      console.error(err);
      const url = thumbImg.currentSrc || thumbImg.src || card.image_url;
      if (url) window.open(url, '_blank', 'noopener');
      else onError?.("Impossible d'agrandir l'image.");
    }
  }

  if (lightbox) {
    // un clic n'importe où (image, fond, croix) ferme ; Échap aussi (natif)
    lightbox.addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('close', () => {
      token += 1; // ignore une grande image encore en chargement
      img.removeAttribute('src');
    });
  }

  // Miniature de la carte : bouton qui ouvre l'image en grand
  // (simple case au dos de carte stylisé si pas d'image)
  function thumbnail(card) {
    const url = providerOf(card)?.thumbUrl?.(card.image_url) ?? card.image_url;

    if (!url || !/^https:\/\//.test(url)) return el('div', 'card-thumb is-missing');

    const box = el('button', 'card-thumb');
    box.type = 'button';
    box.setAttribute('aria-label', `Agrandir l'image de ${card.name}`);

    const image = document.createElement('img');
    image.alt = ''; // décorative : le nom de la carte est juste à côté
    image.width = 56;
    image.height = 82;
    image.decoding = 'async';
    image.dataset.src = url;
    image.addEventListener('error', () => {
      // la version réduite a peut-être été refusée : on retente avec l'image d'origine
      const original = card.image_url;
      if (!image.dataset.retried && original && original !== image.dataset.src && /^https:\/\//.test(original)) {
        image.dataset.retried = '1';
        image.src = original;
        return;
      }
      image.remove();
      box.classList.add('is-missing');
      box.disabled = true;
      box.removeAttribute('aria-label');
    });
    box.addEventListener('click', () => open(card, image));
    box.append(image);

    if (observer) observer.observe(image);
    else image.src = url;
    return box;
  }

  return { thumbnail, resetObserver: () => observer?.disconnect() };
}

// ---------- Démarrage d'une page : session obligatoire ----------

export function showStaleWarning(files) {
  if ($('stale-warning')) return;
  const box = el(
    'p',
    'stale-banner',
    `Certains fichiers du site ne sont pas à jour (cache du navigateur ou dépôt GitHub). Recharge avec Ctrl + Maj + R ; si ce message revient, vérifie que ${files} sont à jour dans ton dépôt.`,
  );
  box.id = 'stale-warning';
  box.setAttribute('role', 'alert');
  document.body.prepend(box);
}

// Déconnexion + redirection si pas de session. Renvoie la session (ou null).
export async function bootPage({ version, files }) {
  window.__tcgVersion = version;

  $('logout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.replace('index.html');
  });
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('index.html');
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    location.replace('index.html');
    return null;
  }
  if (document.body.dataset.version !== version) showStaleWarning(files);
  return session;
}

// Pastille « Offres » du menu : offres reçues à traiter + réponses à tes offres pas encore lues
export async function refreshOfferBadge(userId) {
  const badge = $('offers-badge');
  if (!badge) return;
  try {
    const [received, answers] = await Promise.all([
      supabase.from('offers').select('id', { count: 'exact', head: true }).eq('to_user', userId).eq('status', 'pending'),
      supabase
        .from('offers')
        .select('id', { count: 'exact', head: true })
        .eq('from_user', userId)
        .in('status', ['accepted', 'declined'])
        .eq('from_seen', false),
    ]);
    if (received.error || answers.error) throw received.error ?? answers.error;
    const n = (received.count ?? 0) + (answers.count ?? 0);
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = n === 0;
    const link = badge.closest('a');
    if (link) link.title = n ? `${n} offre${n > 1 ? 's' : ''} à consulter` : 'Offres';
  } catch {
    badge.hidden = true; // pas de table des offres (script SQL non exécuté) : on n'affiche rien
  }
}

// Affiche la page et le pseudo (repli : début de l'email interne)
export async function revealPage(session) {
  document.body.hidden = false;
  refreshOfferBadge(session.user.id); // sans attendre : la page reste rapide
  $('username').textContent = session.user.email?.split('@')[0] ?? '';
  const { data: profile } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', session.user.id)
    .maybeSingle();
  if (profile?.username) $('username').textContent = profile.username;
}

// Déclenche le téléchargement d'un objet JSON (export de données, RGPD)
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const ALL_FILES =
  'collection.html, wishlist.html, decks.html, offres.html, collection.js, decks.js, offres.js, offers.js, common.js, deck-rules.js, games.js, yugioh.js, riftbound.js, pokemon.js, magic.js et onepiece.js';
