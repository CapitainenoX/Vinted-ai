# Vinted AI

Extension Chrome (Manifest V3) : un **agent IA pour vendeurs Vinted**. Il rédige tes annonces à partir des photos, fixe le prix d'après le marché, audite la concurrence, range tes articles dans une bibliothèque numérotée et suit tes ventes dans un dashboard.

Aucun build : c'est du JavaScript vanilla, tu charges le dossier `extension/` tel quel.

## Installation (2 min)

1. `chrome://extensions` → active le **Mode développeur** → **Charger l'extension non empaquetée** → choisis le dossier `extension/`.
2. Le dashboard s'ouvre sur **Paramètres** : colle une clé API **Groq** (gratuite : https://console.groq.com/keys) → **Tester**.
3. Va sur Vinted → **Vendre** : le panel s'ouvre à droite (ou clique sur la bulle en bas à droite, raccourci **Alt+V**).

## Ce que ça fait

| Où | Fonction |
|----|----------|
| **Formulaire "Vendre"** | Détecte les photos que tu as ajoutées → analyse vision (marque, étiquette, taille, matière, défauts) → cherche les annonces comparables sur Vinted → génère titre, description + hashtags, prix (conseillé / rapide / max), marque, taille, état, couleur, matière, catégorie, note /100 et ce qu'il manque. **Appliquer** remplit le formulaire. |
| **Auditer** | Compare ton annonce à la concurrence : prix vs médiane, mots-clés absents, champs vides, photos manquantes, meilleur titre (appliquable en 1 clic). |
| **Agent (chat)** | Chat agentique avec outils : `search_vinted` (stats prix), `web_search`, `fetch_url`, `read_page`, `analyze_photos`, `propose_listing`, `fill_form`, bibliothèque (`library_*`), `relist_item`. Tu peux glisser/coller des photos. Il connaît le copywriting, le SEO de la recherche Vinted, le pricing et les leviers pour faire remonter un article. |
| **Bibliothèque** | Chaque article reçoit un numéro **#0001, #0002…** à écrire sur son sachet de stockage. Notes, emplacement, coût d'achat, prix de vente, acheteur, statut (brouillon / en vente / vendu / archivé). |
| **Numéros intelligents** | Chaque nouvel article prend le **plus petit numéro libre** : supprime #0001 et #0002, le suivant redevient #0001. Option : réutiliser les numéros des articles vendus/archivés. Clic sur le numéro (panel ou dashboard) pour le **changer** ; s'il est pris, on te propose d'**échanger**. |
| **Pages Vinted** | Un badge **#numéro** s'affiche sur chaque lien vers un de tes articles (dressing, messages, ventes) : tu sais tout de suite quel sachet prendre. |
| **Fiche article** | Le panel détecte si l'annonce est **la tienne** (boutons Modifier/Supprimer, vendeur reconnu, ou déjà liée) ou **celle d'un autre** (Acheter / Faire une offre). **Mienne** → numéro, statut, notes, optimiser, faire remonter, vérifier le prix, republier. **Autre vendeur** → position marché, bonne affaire à revendre ?, comparer à mes annonces, message de négociation, « ajouter comme achat ». Bouton « Pas la mienne ? / C'est la mienne ? » si la détection se trompe. |
| **Republier** | Ouvre un nouveau formulaire Vinted pré-rempli (texte + photos) pour remettre un article qui stagne en tête des nouveautés. |
| **Dashboard** | CA, bénéfice, panier moyen, délai de vente, taux d'écoulement, ventes par semaine, top marques, articles "à relancer" (+21 jours) avec prix conseillé −12 %. Export CSV, sauvegarde/import JSON. Clair/sombre. |

## Fournisseurs IA

Tout endpoint compatible OpenAI : **Groq** (défaut), OpenRouter, OpenAI, Mistral, ou personnalisé (Ollama, LM Studio…). Deux modèles :
- **agent** (doit gérer les tools) — défaut Groq `openai/gpt-oss-120b`
- **vision** (photos) — défaut Groq `qwen/qwen3.8-27b` (max 3 images/requête)

Les modèles changent souvent : **Charger les modèles** liste ceux de ton compte. Recherche web : DuckDuckGo par défaut, ou une clé **Tavily** pour des résultats plus fiables.

## Confidentialité

Clés et bibliothèque restent dans `chrome.storage.local`. Les appels partent directement de ton navigateur vers le fournisseur choisi. Les exports n'incluent jamais les clés.

## Limites connues

- Le HTML de Vinted n'est pas une API publique : le remplissage utilise des sélecteurs avec plusieurs replis (id, `data-testid`, libellés). Titre / description / prix sont fiables ; les listes déroulantes (marque, taille, état, couleur) sont en "best effort" — le panel indique ce qui reste à faire à la main. La **catégorie** n'est pas remplie automatiquement (elle est proposée en texte).
- `search_vinted` appelle l'API catalogue de Vinted depuis ton onglet Vinted (tes cookies de session) : garde un onglet Vinted ouvert.
- Le Boost payant de Vinted n'est pas automatisé ; l'agent te conseille quand il vaut le coût.

## Structure

```
extension/
  manifest.json
  background.js          service worker : routeur de messages, boucle agent, pipeline annonce/audit
  lib/                   storage (bibliothèque, réglages, stats) · llm (client OpenAI-compatible)
                         prompts (prompt système Vinted) · tools (outils de l'agent) · web · vinted-api
  content/               vinted-page.js (lecture/remplissage formulaire, photos, badges) · panel.js/.css
  shared/                tokens.css (style contract) · chat-ui.js · md.js · icons.js (Lucide)
  dashboard/             page dashboard (vue d'ensemble, bibliothèque, agent, paramètres)
  popup/                 popup de l'icône
tools/
  e2e.mjs                test bout-en-bout (Chromium + extension + fausses pages Vinted + faux LLM)
  mock-llm.mjs           serveur OpenAI factice pour les tests
  make-icons.mjs         génère les PNG d'icônes
```

## Tests

```bash
node tools/mock-llm.mjs &      # faux LLM sur :8787
node tools/e2e.mjs             # 33 vérifications ; captures dans test-results/
```
Nécessite `playwright` (local ou global) et Chromium.
