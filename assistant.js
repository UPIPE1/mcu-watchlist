/* ──────────────────────────────────────────────────────────────────────
   ASK MCU — offline, rule-based movie-database assistant
   ──────────────────────────────────────────────────────────────────────
   This is NOT a generative AI model. It does not call any API, download
   any model, or generate novel text. It answers a fixed set of question
   *types* by pattern-matching the user's message against known intents,
   then looks up / computes the answer from the page's existing `DATA`,
   `allMovies` and `watched` data structures (already defined in index.html,
   in the same global scope since both are classic, non-module scripts).

   It is deliberately structured so a real local model (WebLLM /
   Transformers.js) could later be dropped in behind the same
   `answerQuestion(text) -> {html, usedFallback}` interface — see the
   ASSISTANT_ENGINE section at the bottom for where that would plug in.
   No such model is downloaded or referenced in this version.
   ────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // Bail out quietly if the host page's data isn't present for some reason
  // (e.g. this script loaded on a different page). Never throw into console
  // in a way that could look like a broken page to the user.
  if (typeof DATA === "undefined" || typeof allMovies === "undefined" || typeof watched === "undefined") {
    console.warn("Ask MCU: expected globals (DATA/allMovies/watched) not found — assistant disabled.");
    return;
  }

  /* ── KNOWLEDGE BASE ──────────────────────────────────────────────── */
  // Flatten DATA into a single ordered list, carrying phase/section info
  // that `allMovies` doesn't include. Order mirrors on-screen watch order.
  const KB = [];
  DATA.forEach(section => {
    section.movies.forEach(m => {
      KB.push({
        ...m,
        id: m.title + "-" + m.year,
        fox: section.fox,
        phase: section.phase,
        sectionSub: section.sub
      });
    });
  });

  const PHASE_LABELS = [...new Set(KB.map(m => m.phase))]; // in DATA order

  function movieId(m) { return m.title + "-" + m.year; }
  function isWatched(m) { return watched.has(movieId(m)); }
  function fmtMins(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return m + "m";
    if (m === 0) return h + "h";
    return h + "h " + m + "m";
  }
  function phaseShort(p) {
    if (p === "FOX X-MEN UNIVERSE") return "Fox X-Men Universe";
    return p.replace("PHASE", "Phase");
  }

  /* ── TEXT UTILITIES (tolerant matching, no deps) ────────────────── */
  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Classic Levenshtein edit distance — small inputs only (titles/names),
  // fine to run uncached at this scale (a few dozen comparisons per query).
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = row[j];
        row[j] = a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = tmp;
      }
    }
    return row[n];
  }

  // Best fuzzy match of `query` against a list of {key, ...payload}, where
  // key is the normalized text to compare against. Returns payload or null.
  function fuzzyBest(query, items, keyFn, threshold) {
    const q = normalize(query);
    if (!q) return null;
    let best = null, bestScore = Infinity, bestLenDiff = Infinity;
    for (const item of items) {
      const key = normalize(keyFn(item));
      if (!key) continue;
      let score;
      if (key === q) score = 0;
      else if (key.includes(q) || q.includes(key)) score = 0.08; // strong signal — substring match, length-independent
      else score = levenshtein(q, key) / Math.max(q.length, key.length);
      const lenDiff = Math.abs(key.length - q.length);
      // On a tie, prefer whichever key is closest in length to the query —
      // avoids e.g. "find X-Men: Days of Future Past" matching bare "X-Men"
      // just because it was iterated first.
      if (score < bestScore || (score === bestScore && lenDiff < bestLenDiff)) {
        bestScore = score; best = item; bestLenDiff = lenDiff;
      }
    }
    const maxAllowed = threshold != null ? threshold : 0.42;
    return bestScore <= maxAllowed ? best : null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function movieLink(m) {
    return `<span class="askmcu-link" data-open-id="${escapeHtml(movieId(m))}">${escapeHtml(m.title)} (${m.year})</span>`;
  }

  function movieListHtml(list, opts) {
    opts = opts || {};
    if (!list.length) return `<i>No matching movies found in the local database.</i>`;
    const max = opts.max || 12;
    const shown = list.slice(0, max);
    let html = "<ul>" + shown.map(m => {
      const w = isWatched(m) ? " ✅" : "";
      const ess = m.priority === "essential" ? "" : " <span style='color:var(--muted)'>(optional)</span>";
      return `<li>${movieLink(m)}${ess}${w}</li>`;
    }).join("") + "</ul>";
    if (list.length > max) html += `<div style="color:var(--muted);font-size:11.5px;margin-top:4px">+${list.length - max} more — use the filters on the main screen to see the full list.</div>`;
    return html;
  }

  /* ── QUERY FUNCTIONS (all read-only; never mutate app state) ───── */
  function qTotals() {
    const watchedCount = KB.filter(isWatched).length;
    const totalMins = KB.reduce((a, m) => a + m.mins, 0);
    const watchedMins = KB.filter(isWatched).reduce((a, m) => a + m.mins, 0);
    const remainingMins = totalMins - watchedMins;
    const essentialTotal = KB.filter(m => m.priority === "essential").length;
    const essentialWatched = KB.filter(m => m.priority === "essential" && isWatched(m)).length;
    return { watchedCount, total: KB.length, totalMins, watchedMins, remainingMins, essentialTotal, essentialWatched };
  }

  function qUnwatched() { return KB.filter(m => !isWatched(m)); }
  function qWatched() { return KB.filter(isWatched); }
  function qEssential() { return KB.filter(m => m.priority === "essential"); }
  function qFox() { return KB.filter(m => m.fox); }
  function qByPhase(label) { return KB.filter(m => m.phase === label); }

  function qFindPhase(query) {
    const q = normalize(query);
    const numMatch = q.match(/phase\s*([1-6])/) || q.match(/\b([1-6])\b/);
    if (numMatch) {
      const label = "PHASE " + numMatch[1];
      if (PHASE_LABELS.includes(label)) return label;
    }
    if (/fox|x[\s-]?men/.test(q)) return "FOX X-MEN UNIVERSE";
    return null;
  }

  function qFindMovie(query) {
    // exact id-ish match first (title + optional year)
    const yearMatch = query.match(/\b(19|20)\d{2}\b/);
    let candidates = KB;
    if (yearMatch) {
      const y = parseInt(yearMatch[0], 10);
      const withYear = KB.filter(m => m.year === y);
      if (withYear.length) candidates = withYear;
    }
    return fuzzyBest(query.replace(/\b(19|20)\d{2}\b/, ""), candidates, m => m.title, 0.45);
  }

  function qFindCharacterMovies(query) {
    const q = normalize(query);
    if (!q) return [];
    // direct substring match across character names first
    let hits = KB.filter(m => m.chars.some(c => normalize(c.name).includes(q) || q.includes(normalize(c.name))));
    if (hits.length) return hits;
    // fuzzy fallback: find closest character name across the whole DB
    const allChars = [];
    KB.forEach(m => m.chars.forEach(c => allChars.push({ movie: m, name: c.name })));
    const best = fuzzyBest(query, allChars, c => c.name, 0.38);
    if (!best) return [];
    const bn = normalize(best.name);
    return KB.filter(m => m.chars.some(c => normalize(c.name) === bn));
  }

  // Search by real-world actor name (uses the new m.cast data), separate
  // from qFindCharacterMovies which searches in-universe character names.
  function qFindActorMovies(query) {
    const q = normalize(query);
    if (!q) return [];
    let hits = KB.filter(m => (m.cast || []).some(a => normalize(a).includes(q) || q.includes(normalize(a))));
    if (hits.length) return hits;
    const allActors = [];
    KB.forEach(m => (m.cast || []).forEach(a => allActors.push({ movie: m, name: a })));
    const best = fuzzyBest(query, allActors, a => a.name, 0.3);
    if (!best) return [];
    const bn = normalize(best.name);
    return KB.filter(m => (m.cast || []).some(a => normalize(a) === bn));
  }

  function qWhatsNextAfter(query) {
    const m = qFindMovie(query);
    if (!m) return { found: null };
    const idx = KB.indexOf(m);
    const next = KB.slice(idx + 1, idx + 4); // next few in the app's order
    return { found: m, next };
  }

  /* ── INTENT ROUTER ───────────────────────────────────────────────
     Each intent is tried in order; first match wins. Kept as plain
     if/regex checks (no framework) per the "lightweight" requirement. */
  function answerQuestion(raw) {
    const text = String(raw || "").slice(0, 300); // guard against absurd input
    const q = normalize(text);
    if (!q) return { html: "Ask me something about the MCU or Fox X-Men lineup! 🎬" };

    // greetings
    if (/^(hi|hello|hey|yo|sup)\b/.test(q) && q.length < 12) {
      return { html: "Hey! I'm the offline MCU assistant — I can only answer from the movie data already in this app (no internet, no outside knowledge). Try asking about watch order, phases, characters, or your watched progress." };
    }

    // help
    if (/what can you do|help\b|how do (i|you) use/.test(q)) {
      return { html: "I can answer things like:<ul>" +
        "<li>What should I watch after [movie]?</li>" +
        "<li>Show essential MCU movies</li>" +
        "<li>Which movies have I not watched?</li>" +
        "<li>How many hours are left?</li>" +
        "<li>List Phase 3 / Fox X-Men movies</li>" +
        "<li>Which movies have [character]?</li>" +
        "<li>When does [movie] release?</li>" +
        "<li>Who stars in / directed [movie]?</li>" +
        "<li>Which movies star [actor]?</li>" +
        "</ul>Everything comes from this app's own local data — I can't look anything up online." };
    }

    // watched count
    if (/how many.*(watched|seen)|watched count|progress/.test(q)) {
      const t = qTotals();
      const pct = Math.round((t.watchedCount / t.total) * 100);
      return { html: `You've watched <b>${t.watchedCount} of ${t.total}</b> movies/shows (${pct}%). That's ${fmtMins(t.watchedMins)} watched, with ${fmtMins(t.remainingMins)} left.` };
    }

    // remaining time
    if ((/\b(hours?|time)\b/.test(q) && /\b(left|remain|remaining)\b/.test(q)) || /how (much|long).*(left|remain)/.test(q)) {
      const t = qTotals();
      return { html: `You have <b>${fmtMins(t.remainingMins)}</b> of content left to watch (${t.total - t.watchedCount} titles), out of ${fmtMins(t.totalMins)} total.` };
    }

    // unwatched list
    if (/(havent|have not|not yet watched|unwatched|still need to watch|what.*left to watch)/.test(q)) {
      const list = qUnwatched();
      return { html: `<b>${list.length} unwatched</b> (in watch order):` + movieListHtml(list) };
    }

    // watched list
    if (/what have i watched|show.*watched\b|list.*watched\b/.test(q) && !/unwatched/.test(q)) {
      const list = qWatched();
      return { html: `<b>${list.length} watched:</b>` + movieListHtml(list) };
    }

    // essential list
    if (/essential/.test(q)) {
      const list = qEssential();
      return { html: `<b>${list.length} essential titles:</b>` + movieListHtml(list, { max: 16 }) };
    }

    // fox x-men list
    if (/fox.*x[\s-]?men|x[\s-]?men.*(movies|list|universe)/.test(q)) {
      const list = qFox();
      return { html: `<b>Fox X-Men Universe — ${list.length} titles:</b>` + movieListHtml(list, { max: 16 }) };
    }

    // phase N list
    if (/phase\s*[1-6]/.test(q) && /(show|list|what|movies|titles)/.test(q)) {
      const label = qFindPhase(q);
      if (label) {
        const list = qByPhase(label);
        return { html: `<b>${phaseShort(label)} — ${list.length} titles:</b>` + movieListHtml(list, { max: 16 }) };
      }
    }

    // watch order (full)
    if (/(correct )?watch order|order to watch|what order/.test(q)) {
      let html = `Here's the app's full watch order (${KB.length} titles), grouped by section:<br>`;
      PHASE_LABELS.forEach(label => {
        const list = qByPhase(label);
        html += `<br><b>${phaseShort(label)}</b>` + movieListHtml(list, { max: 8 });
      });
      return { html };
    }

    // "what should I watch after X"
    const afterMatch = text.match(/after\s+(.+?)[\?\.!]*$/i) || text.match(/next\s+(?:movie\s+)?after\s+(.+?)[\?\.!]*$/i);
    if (afterMatch && afterMatch[1].trim().length > 1) {
      const { found, next } = qWhatsNextAfter(afterMatch[1]);
      if (!found) {
        return { html: `I couldn't find "${escapeHtml(afterMatch[1].trim())}" in the local database — double-check the title?` };
      }
      if (!next || !next.length) {
        return { html: `${movieLink(found)} is the last title in the current watch order — you're all caught up! 🎉` };
      }
      return { html: `After ${movieLink(found)}, next up is:` + movieListHtml(next, { max: 3 }) };
    }

    // release date — "when does X release/come out", "release date of X"
    const releaseMatch = text.match(/when (?:does|did|is)\s+(.+?)\s+(?:release|releasing|come out|coming out|out)[\?\.!]*$/i)
      || text.match(/release date (?:of|for)\s+(.+?)[\?\.!]*$/i);
    if (releaseMatch) {
      const found = qFindMovie(releaseMatch[1]);
      if (found) {
        return { html: found.release
          ? `${movieLink(found)} releases/released on <b>${escapeHtml(found.release)}</b>.`
          : `I don't have a release date on file for ${movieLink(found)}.` };
      }
      return { html: `I couldn't find "${escapeHtml(releaseMatch[1].trim())}" in the local database.` };
    }

    // director — "who directed X"
    const directorMatch = text.match(/who direct(?:ed|s)\s+(.+?)[\?\.!]*$/i);
    if (directorMatch) {
      const found = qFindMovie(directorMatch[1]);
      if (found) {
        return { html: found.director
          ? `${movieLink(found)} was directed by <b>${escapeHtml(found.director)}</b>.`
          : `I don't have director info on file for ${movieLink(found)}.` };
      }
      return { html: `I couldn't find "${escapeHtml(directorMatch[1].trim())}" in the local database.` };
    }

    // cast — "who stars in X" / "cast of X" / "who is in X"
    const castMatch = text.match(/(?:cast of|who stars in|who is in|who'?s in)\s+(.+?)[\?\.!]*$/i);
    if (castMatch) {
      const found = qFindMovie(castMatch[1]);
      if (found) {
        return { html: (found.cast && found.cast.length)
          ? `${movieLink(found)} stars: ${escapeHtml(found.cast.join(", "))}.`
          : `I don't have cast info on file for ${movieLink(found)}.` };
      }
      return { html: `I couldn't find "${escapeHtml(castMatch[1].trim())}" in the local database.` };
    }

    // actor search — "which movies star Tom Holland" / "movies with Robert Downey Jr"
    const actorMatch = text.match(/(?:movies?|titles?).*(?:star(?:ring|s)?|with|featuring)\s+([a-z0-9' .-]+?)[\?\.!]*$/i);
    if (actorMatch) {
      const hits = qFindActorMovies(actorMatch[1]);
      if (hits.length) {
        return { html: `<b>${escapeHtml(actorMatch[1].trim())}</b> appears in:` + movieListHtml(hits, { max: 12 }) };
      }
    }

    // find a movie by title/year — strip the leading command phrase first so
    // "find X-Men: Days of Future Past" searches for the title, not "find …"
    if (/find|search|tell me about|info (on|about)|what year/.test(q)) {
      const stripped = text.replace(/^\s*(find|search( for)?|tell me about|info (on|about)|what year (is|was))\s+/i, "");
      const found = qFindMovie(stripped);
      if (found) return { html: movieDetailHtml(found) };
    }

    // character search — "movies with X" / "which movies feature X" / "who is X"
    const charMatch = text.match(/(?:feature|featuring|with|has|have)\s+([a-z0-9' .-]+?)[\?\.!]*$/i)
      || text.match(/who is\s+([a-z0-9' .-]+?)[\?\.!]*$/i)
      || text.match(/which movies?.*\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
    if (charMatch) {
      const hits = qFindCharacterMovies(charMatch[1]);
      if (hits.length) {
        return { html: `<b>${escapeHtml(charMatch[1].trim())}</b> appears in:` + movieListHtml(hits, { max: 12 }) };
      }
      const actorHits = qFindActorMovies(charMatch[1]);
      if (actorHits.length) {
        return { html: `<b>${escapeHtml(charMatch[1].trim())}</b> appears in:` + movieListHtml(actorHits, { max: 12 }) };
      }
    }

    // last-resort: try matching the whole message as a movie title (covers
    // bare "Avengers Endgame" style queries with no keyword at all)
    const direct = qFindMovie(text);
    if (direct) return { html: movieDetailHtml(direct) };

    // last-resort: try matching as a character name, then as a real actor name
    const charHits = qFindCharacterMovies(text);
    if (charHits.length) {
      return { html: `Found movies featuring that character:` + movieListHtml(charHits, { max: 12 }) };
    }
    const actorHitsLast = qFindActorMovies(text);
    if (actorHitsLast.length) {
      return { html: `Found movies with that actor:` + movieListHtml(actorHitsLast, { max: 12 }) };
    }

    // unsupported
    return {
      html: "I couldn't find that in this app's local movie database — I only know what's already in the watchlist (titles, phases, characters, and your watched status). Try rephrasing, or ask me to list a phase, show essentials, or search a specific title.",
      usedFallback: true
    };
  }

  function movieDetailHtml(m) {
    const w = isWatched(m) ? "✅ Watched" : "▶ Not watched yet";
    let html = `${movieLink(m)}<br><span style="color:var(--sub)">${phaseShort(m.phase)} · ${fmtMins(m.mins)} · ${m.priority === "essential" ? "Essential" : "Optional"} · ${w}</span>`;
    if (m.release) html += `<br><span style="color:var(--sub)">📅 ${escapeHtml(m.release)}</span>`;
    if (m.director) html += `<br><span style="color:var(--sub)">🎬 Directed by ${escapeHtml(m.director)}</span>`;
    if (m.cast && m.cast.length) html += `<br><span style="color:var(--sub)">⭐ ${escapeHtml(m.cast.slice(0, 5).join(", "))}</span>`;
    if (m.note) html += `<br>${escapeHtml(m.note)}`;
    return html;
  }

  /* ── ASSISTANT_ENGINE ────────────────────────────────────────────
     Swap point for a future local LLM (WebLLM / Transformers.js).
     `engine.respond(text)` must return {html, usedFallback?} just like
     answerQuestion() above. Keeping this indirection means the UI code
     below never needs to change when a real model is added later. */
  const ruleBasedEngine = { respond: (text) => answerQuestion(text) };
  let ASSISTANT_ENGINE = ruleBasedEngine; // only engine wired up in this version

  /* ── CHAT UI ─────────────────────────────────────────────────────── */
  const SUGGESTIONS = [
    "What should I watch after Avengers: Endgame?",
    "Show essential MCU movies",
    "How many have I watched?",
    "How many hours are left?",
    "List Fox X-Men movies",
    "Show Phase 3 movies",
    "Which movies feature Wolverine?",
    "When does Avengers: Doomsday release?",
    "Who stars in Deadpool & Wolverine?",
    "Which movies star Robert Downey Jr.?",
    "What is the watch order?"
  ];

  let messages = []; // {role:'user'|'bot', html}
  let panelOpen = false;

  function el(id) { return document.getElementById(id); }

  function renderEmptyState() {
    return `<div class="askmcu-empty"><b>Ask MCU 🤖</b>
      A fast, fully offline assistant for this watchlist — it only answers from the movie data already on this page, nothing is downloaded or sent anywhere.
      <div class="askmcu-suggestions">${SUGGESTIONS.map(s => `<button class="askmcu-chip" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}</div>
      </div>`;
  }

  function renderMessages() {
    const body = el("askmcuBody");
    if (!messages.length) { body.innerHTML = renderEmptyState(); return; }
    body.innerHTML = messages.map(m =>
      `<div class="askmcu-msg ${m.role === "user" ? "user" : "bot"}">${m.html}</div>`
    ).join("");
    body.scrollTop = body.scrollHeight;
  }

  function showTyping() {
    const body = el("askmcuBody");
    const t = document.createElement("div");
    t.className = "askmcu-typing";
    t.id = "askmcuTyping";
    t.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
  }
  function hideTyping() {
    const t = el("askmcuTyping");
    if (t) t.remove();
  }

  function sendMessage(text) {
    text = (text || "").trim();
    if (!text) return;
    messages.push({ role: "user", html: escapeHtml(text) });
    renderMessages();
    showTyping();
    // Small simulated delay for a natural chat feel — purely cosmetic UI
    // state, not a sign of "thinking"; computation itself is instant/local.
    setTimeout(() => {
      hideTyping();
      let result;
      try {
        result = ASSISTANT_ENGINE.respond(text);
      } catch (e) {
        result = { html: "Something went wrong answering that locally — try a simpler phrasing." };
      }
      messages.push({ role: "bot", html: result.html });
      renderMessages();
    }, 350 + Math.random() * 250);
  }

  function openPanel() {
    panelOpen = true;
    el("askmcuPanel").classList.add("open");
    el("askmcuOverlay").classList.add("open");
    el("askmcuBtn").classList.remove("has-unread");
    renderMessages();
    setTimeout(() => el("askmcuInput").focus(), 260);
  }
  function closePanel() {
    panelOpen = false;
    el("askmcuPanel").classList.remove("open");
    el("askmcuOverlay").classList.remove("open");
    el("askmcuInput").blur();
  }

  function wire() {
    el("askmcuBtn").addEventListener("click", () => panelOpen ? closePanel() : openPanel());
    el("askmcuCloseBtn").addEventListener("click", closePanel);
    el("askmcuOverlay").addEventListener("click", closePanel);
    el("askmcuClearBtn").addEventListener("click", () => { messages = []; renderMessages(); });

    el("askmcuSend").addEventListener("click", () => {
      const input = el("askmcuInput");
      sendMessage(input.value);
      input.value = "";
    });
    el("askmcuInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const input = el("askmcuInput");
        sendMessage(input.value);
        input.value = "";
      }
    });

    // Delegate clicks for suggestion chips and in-answer movie links
    el("askmcuBody").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-suggest]");
      if (chip) { sendMessage(chip.getAttribute("data-suggest")); return; }
      const link = e.target.closest("[data-open-id]");
      if (link && typeof openModal === "function") {
        closePanel();
        openModal(link.getAttribute("data-open-id"));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
