'use strict';

(() => {
  /* =========================================================
     Config
     ========================================================= */

  const CONFIG = {
    LIMIT: 280,
    URL_WEIGHT: 23,
    WARN_AT: 260,
    HOOK_COUNT: 5,
    TOAST_MS: 1800,
    STORAGE_KEY: 'thread-studio:v2',
    THREAD_SEPARATOR: '\n\n---\n\n',
    RING_RADIUS: 9,
  };

  const SAMPLE_TEXT = [
    'I shipped my first SaaS in 30 days, and the biggest lesson had nothing to do with code.',
    'I spent the first week building features nobody asked for. I polished dashboards, tweaked animations, and wrote a perfect onboarding flow for users who did not exist yet.',
    'Then I talked to five potential customers. Three of them wanted the same boring feature: a CSV export. I built it in two hours, and it became the reason people signed up.',
    "Here's what I'd tell my past self: Talk to users before you write code. Ship the smallest useful version. Let real feedback decide what comes next.",
    "If you're building something right now, what's the one feature you're sure people want? Go and test it this week.",
  ].join('\n\n');

  /* =========================================================
     TextMetrics: X-style weighted character counting
     ========================================================= */

  const TextMetrics = {
    URL_PATTERN: /https?:\/\/\S+/g,

    weight(text) {
      const normalized = text.replace(this.URL_PATTERN, 'x'.repeat(CONFIG.URL_WEIGHT));
      let total = 0;
      for (const char of normalized) {
        const code = char.codePointAt(0);
        const isLight =
          code <= 4351 ||
          (code >= 8192 && code <= 8205) ||
          (code >= 8208 && code <= 8223) ||
          (code >= 8242 && code <= 8247);
        total += isLight ? 1 : 2;
      }
      return total;
    },

    digits(number) {
      return String(number).length;
    },
  };

  /* =========================================================
     ThreadSplitter: sentence-aware splitting for English text
     ========================================================= */

  const ThreadSplitter = {
    ABBREVIATION_END: /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|inc|ltd|approx|est|fig|e\.g|i\.e|a\.m|p\.m|u\.s|u\.k)\.|\b[a-z]\.[a-z]\.)$/i,
    FORCED_BREAK: /^[ \t]*---[ \t]*$/m,

    SENTENCE_SPLIT: (() => {
      try {
        return new RegExp('(?<=[.!?…]["”’\')\\]]*)\\s+(?=\\S)');
      } catch (error) {
        return null;
      }
    })(),
    SENTENCE_FALLBACK: /[^.!?…]+(?:[.!?…]+["”’')\]]*|$)/g,

    splitSentences(line) {
      const raw = this.SENTENCE_SPLIT
        ? line.split(this.SENTENCE_SPLIT)
        : line.match(this.SENTENCE_FALLBACK) || [line];

      const merged = [];
      for (const piece of raw.map((s) => s.trim()).filter(Boolean)) {
        const previous = merged[merged.length - 1];
        if (previous && this.ABBREVIATION_END.test(previous)) {
          merged[merged.length - 1] = previous + ' ' + piece;
        } else {
          merged.push(piece);
        }
      }
      return merged;
    },

    // Turns a block of text into sentence units. Each unit remembers which
    // separator belongs in front of it: blank line, line break, or space.
    toUnits(block) {
      const units = [];
      const paragraphs = block
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);

      paragraphs.forEach((paragraph) => {
        const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
        lines.forEach((line, lineIndex) => {
          this.splitSentences(line).forEach((text, sentenceIndex) => {
            let separator = ' ';
            if (sentenceIndex === 0) separator = lineIndex === 0 ? '\n\n' : '\n';
            units.push({ text, separator });
          });
        });
      });
      return units;
    },

    hardSplit(word, limit) {
      const parts = [];
      let current = '';
      for (const char of word) {
        if (TextMetrics.weight(current + char) > limit) {
          parts.push(current);
          current = char;
        } else {
          current += char;
        }
      }
      if (current) parts.push(current);
      return parts;
    },

    // Splits an oversized sentence at word boundaries, and as a last resort inside a word.
    fit(text, limit) {
      if (TextMetrics.weight(text) <= limit) return [text];

      const chunks = [];
      let current = '';
      for (const word of text.split(/\s+/)) {
        const pieces = TextMetrics.weight(word) > limit ? this.hardSplit(word, limit) : [word];
        for (const piece of pieces) {
          const next = current ? current + ' ' + piece : piece;
          if (current && TextMetrics.weight(next) > limit) {
            chunks.push(current);
            current = piece;
          } else {
            current = next;
          }
        }
      }
      if (current) chunks.push(current);
      return chunks;
    },

    // Greedy packing: fit as many whole sentences as possible into each post.
    pack(units, limit) {
      const posts = [];
      let current = '';
      for (const unit of units) {
        this.fit(unit.text, limit).forEach((piece, index) => {
          const separator = !current ? '' : index === 0 ? unit.separator : ' ';
          if (current && TextMetrics.weight(current + separator + piece) > limit) {
            posts.push(current);
            current = piece;
          } else {
            current += separator + piece;
          }
        });
      }
      if (current) posts.push(current);
      return posts;
    },

    // Returns the post bodies without numbering. When numbering is on, room for
    // "\n\n" + "i/n" is reserved so the finished posts never exceed the limit.
    build(text, numbering) {
      const blocks = text.split(this.FORCED_BREAK).map((b) => b.trim()).filter(Boolean);
      if (!blocks.length) return [];

      const unitSets = blocks.map((block) => this.toUnits(block));
      const packAll = (limit) => unitSets.flatMap((units) => this.pack(units, limit));

      const plain = packAll(CONFIG.LIMIT);
      if (plain.length <= 1 || !numbering) return plain;

      let count = plain.length;
      for (let attempt = 0; attempt < 6; attempt++) {
        const reserve = 2 + TextMetrics.digits(count) * 2 + 1;
        const candidate = packAll(CONFIG.LIMIT - reserve);
        if (TextMetrics.digits(candidate.length) <= TextMetrics.digits(count)) return candidate;
        count = candidate.length;
      }
      return packAll(CONFIG.LIMIT - (2 + TextMetrics.digits(count) * 2 + 1));
    },

    // Returns the finished post texts, numbered when requested.
    format(text, numbering) {
      const bodies = this.build(text, numbering);
      const total = bodies.length;
      if (!numbering || total <= 1) return bodies;
      return bodies.map((body, index) => `${body}\n\n${index + 1}/${total}`);
    },
  };

  /* =========================================================
     HookGenerator: structured English hook templates
     ========================================================= */

  const HookGenerator = {
    TEMPLATES: {
      curiosity: [
        "Nobody talks about this side of {topic}.\n\nBut it changes everything once you see it. 🧵",
        "I spent 6 months studying {topic}.\n\nThe most surprising lesson wasn't what I expected.",
        'What if everything you know about {topic} is slightly wrong?',
        "There's a hidden pattern behind every successful {topic} effort.\n\nOnce you spot it, you can't unsee it:",
        'The strangest thing I learned about {topic} this year:',
        'Why do so few people master {topic}?\n\nThe answer is simpler than you think.',
        "Here's a {topic} secret most experts rarely share:",
      ],
      'before-after': [
        '6 months ago, I knew almost nothing about {topic}.\n\nToday it is a core part of how I work. Here is what changed: 🧵',
        'Before: guessing my way through {topic}.\nAfter: a repeatable system.\n\nThe 5 shifts that made the difference:',
        'I used to struggle with {topic}.\n\nThen I changed one thing. Everything got easier.',
        'My {topic} results a year ago vs. today.\n\nSame person, different approach. Here is the breakdown:',
        'Old me: overcomplicating {topic}.\nNew me: keeping it ruthlessly simple.\n\nHere is the playbook:',
        'Before I fixed my approach to {topic}: stuck.\nAfter: finally moving.\n\nWhat I did differently:',
      ],
      controversial: [
        'Unpopular opinion: most {topic} advice is a waste of time.\n\nHere is what to do instead:',
        'Stop overthinking {topic}.\n\nIt is holding you back more than you realize.',
        "{Topic} is overrated.\n\nI'll explain why, and you might not like it.",
        "Hot take: you don't need more {topic} tutorials. You need to ship something.",
        'Everyone tells you to start with {topic}.\n\nThat is backwards. Here is why:',
        "I'm going to say what nobody wants to hear about {topic}:",
        'The {topic} playbook everyone follows is broken.\n\nHere is the proof:',
      ],
      'how-i': [
        'How I got better at {topic} in 30 days (without burning out):\n\n🧵',
        'How I approach {topic}, step by step:\n\nSteal this process.',
        'How I built a simple system for {topic}.\n\nHere is the exact breakdown:',
        "How I'd learn {topic} from scratch if I started today:",
        'How I turned {topic} into a daily habit.\n\nThe 4 rules I follow:',
        'How I use {topic} to save hours every week.\n\nHere is my full workflow:',
      ],
    },

    normalizeTopic(raw) {
      return raw.replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
    },

    capitalize(text) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    },

    shuffle(list) {
      const copy = list.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },

    generate(rawTopic, tone, count) {
      const topic = this.normalizeTopic(rawTopic);
      if (!topic) return [];
      const templates = this.TEMPLATES[tone] || this.TEMPLATES.curiosity;
      return this.shuffle(templates)
        .slice(0, count)
        .map((template) =>
          template.split('{topic}').join(topic).split('{Topic}').join(this.capitalize(topic))
        );
    },
  };

  /* =========================================================
     Clipboard, Toast, Store
     ========================================================= */

  const Clipboard = {
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(helper);
        helper.select();
        let success = false;
        try {
          success = document.execCommand('copy');
        } catch (fallbackError) {
          success = false;
        }
        helper.remove();
        return success;
      }
    },
  };

  const Toast = {
    timer: null,
    show(message) {
      const node = document.getElementById('toast');
      node.textContent = message;
      node.classList.add('is-visible');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => node.classList.remove('is-visible'), CONFIG.TOAST_MS);
    },
  };

  const Store = {
    load() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || 'null');
      } catch (error) {
        return null;
      }
    },
    save(data) {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
      } catch (error) {
        /* Storage can be unavailable (private mode, file URLs). The app still works without it. */
      }
    },
  };

  /* =========================================================
     UI helpers
     ========================================================= */

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createButton(label, className, action, index) {
    const button = createElement('button', className, label);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.index = String(index);
    return button;
  }

  function flashButton(button, doneLabel) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = doneLabel;
    button.classList.add('is-done');
    clearTimeout(button._flashTimer);
    button._flashTimer = setTimeout(() => {
      button.textContent = original;
      button.classList.remove('is-done');
    }, 1600);
  }

  function createCounter(weight) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const circumference = 2 * Math.PI * CONFIG.RING_RADIUS;
    const ratio = Math.min(1, weight / CONFIG.LIMIT);

    const wrapper = createElement('div', 'counter');
    if (weight > CONFIG.LIMIT) wrapper.classList.add('is-over');
    else if (weight >= CONFIG.WARN_AT) wrapper.classList.add('is-warn');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const background = document.createElementNS(SVG_NS, 'circle');
    background.setAttribute('class', 'ring-bg');
    background.setAttribute('cx', '12');
    background.setAttribute('cy', '12');
    background.setAttribute('r', String(CONFIG.RING_RADIUS));

    const foreground = document.createElementNS(SVG_NS, 'circle');
    foreground.setAttribute('class', 'ring-fg');
    foreground.setAttribute('cx', '12');
    foreground.setAttribute('cy', '12');
    foreground.setAttribute('r', String(CONFIG.RING_RADIUS));
    foreground.setAttribute('stroke-dasharray', circumference.toFixed(2));
    foreground.setAttribute('stroke-dashoffset', (circumference * (1 - ratio)).toFixed(2));

    svg.append(background, foreground);
    wrapper.append(svg, createElement('span', '', `${weight}/${CONFIG.LIMIT}`));
    return wrapper;
  }

  /* =========================================================
     App
     ========================================================= */

  const App = {
    state: {
      hooks: [],
      posts: [],
      lastInsertedHook: '',
    },
    dom: {},

    init() {
      this.cacheDom();
      this.restore();
      this.bindEvents();
      this.renderThread();
    },

    cacheDom() {
      const ids = {
        hookForm: 'hook-form',
        topic: 'topic',
        tone: 'tone',
        topicError: 'topic-error',
        hookEmpty: 'hook-empty',
        hookResults: 'hook-results',
        input: 'thread-input',
        numbering: 'opt-numbering',
        sample: 'btn-sample',
        clear: 'btn-clear',
        statChars: 'stat-chars',
        statPosts: 'stat-posts',
        name: 'in-name',
        handle: 'in-handle',
        copyAll: 'btn-copy-all',
        thread: 'thread',
        previewEmpty: 'preview-empty',
        editorPanel: 'editor-panel',
      };
      Object.keys(ids).forEach((key) => {
        this.dom[key] = document.getElementById(ids[key]);
      });
    },

    restore() {
      const saved = Store.load();
      if (!saved) return;
      if (typeof saved.topic === 'string') this.dom.topic.value = saved.topic;
      if (typeof saved.tone === 'string' && this.dom.tone.querySelector(`option[value="${saved.tone}"]`)) {
        this.dom.tone.value = saved.tone;
      }
      if (typeof saved.text === 'string') this.dom.input.value = saved.text;
      if (typeof saved.numbering === 'boolean') this.dom.numbering.checked = saved.numbering;
      if (saved.name) this.dom.name.value = saved.name;
      if (saved.handle) this.dom.handle.value = saved.handle;
    },

    persist() {
      Store.save({
        topic: this.dom.topic.value,
        tone: this.dom.tone.value,
        text: this.dom.input.value,
        numbering: this.dom.numbering.checked,
        name: this.dom.name.value,
        handle: this.dom.handle.value,
      });
    },

    bindEvents() {
      const { dom } = this;

      dom.hookForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.handleGenerate();
      });
      dom.topic.addEventListener('input', () => {
        dom.topicError.hidden = true;
        this.persist();
      });
      dom.tone.addEventListener('change', () => this.persist());
      dom.hookResults.addEventListener('click', (event) => this.handleHookClick(event));

      dom.input.addEventListener('input', () => this.handleChange());
      dom.numbering.addEventListener('change', () => this.handleChange());
      dom.name.addEventListener('input', () => this.handleChange());
      dom.handle.addEventListener('input', () => this.handleChange());

      dom.sample.addEventListener('click', () => {
        dom.input.value = SAMPLE_TEXT;
        this.state.lastInsertedHook = '';
        this.handleChange();
      });
      dom.clear.addEventListener('click', () => {
        dom.input.value = '';
        this.state.lastInsertedHook = '';
        this.handleChange();
        dom.input.focus();
      });
      dom.copyAll.addEventListener('click', () => this.handleCopyAll());
      dom.thread.addEventListener('click', (event) => this.handlePostClick(event));
    },

    handleChange() {
      this.renderThread();
      this.persist();
    },

    /* ---------- Hook generator ---------- */

    handleGenerate() {
      const { dom } = this;
      const hooks = HookGenerator.generate(dom.topic.value, dom.tone.value, CONFIG.HOOK_COUNT);
      if (!hooks.length) {
        dom.topicError.hidden = false;
        dom.topic.focus();
        return;
      }
      dom.topicError.hidden = true;
      this.state.hooks = hooks;
      this.renderHooks();
      this.persist();
    },

    renderHooks() {
      const { hookResults, hookEmpty } = this.dom;
      hookResults.replaceChildren();
      hookEmpty.hidden = this.state.hooks.length > 0;

      this.state.hooks.forEach((hook, index) => {
        const item = createElement('li', 'hook-card');
        item.appendChild(createElement('p', 'hook-text', hook));

        const actions = createElement('div', 'hook-actions');
        actions.append(
          createButton('Insert Hook into Thread', 'btn btn-primary btn-sm', 'insert-hook', index),
          createButton('Copy Hook', 'btn btn-sm', 'copy-hook', index)
        );
        item.appendChild(actions);
        hookResults.appendChild(item);
      });
    },

    async handleHookClick(event) {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const hook = this.state.hooks[Number(button.dataset.index)];
      if (!hook) return;

      if (button.dataset.action === 'insert-hook') {
        this.insertHook(hook);
      } else if (button.dataset.action === 'copy-hook') {
        const ok = await Clipboard.copy(hook);
        if (ok) {
          flashButton(button, 'Copied');
          Toast.show('Hook copied');
        } else {
          Toast.show('Copy failed. Select the text and copy it manually.');
        }
      }
    },

    insertHook(hook) {
      const { input, editorPanel } = this.dom;
      let existing = input.value.replace(/^\s+/, '');

      // Swap out a hook that was inserted earlier instead of stacking hooks.
      const previous = this.state.lastInsertedHook;
      if (previous && existing.startsWith(previous)) {
        existing = existing.slice(previous.length).replace(/^\s+/, '');
      }

      input.value = existing ? `${hook}\n\n${existing}` : `${hook}\n\n`;
      this.state.lastInsertedHook = hook;

      const caret = existing ? hook.length + 2 : input.value.length;
      input.focus();
      input.setSelectionRange(caret, caret);

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      editorPanel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });

      this.handleChange();
      Toast.show('Hook inserted at the start of your thread');
    },

    /* ---------- Thread editor and preview ---------- */

    renderThread() {
      const { dom } = this;
      const text = dom.input.value;
      const posts = ThreadSplitter.format(text, dom.numbering.checked);
      this.state.posts = posts;

      dom.statChars.textContent = `${text.length.toLocaleString('en-US')} ${text.length === 1 ? 'character' : 'characters'}`;
      dom.statPosts.textContent = `${posts.length} ${posts.length === 1 ? 'post' : 'posts'}`;
      dom.copyAll.disabled = posts.length === 0;

      dom.thread.replaceChildren();
      dom.thread.hidden = posts.length === 0;
      dom.previewEmpty.hidden = posts.length > 0;
      if (!posts.length) return;

      const name = dom.name.value.trim() || 'Your Name';
      const handle = (dom.handle.value.trim() || 'yourhandle').replace(/^@/, '');
      const initial = Array.from(name)[0].toUpperCase();

      posts.forEach((post, index) => {
        const article = createElement('article', 'post');

        const rail = createElement('div', 'post-rail');
        rail.appendChild(createElement('div', 'post-avatar', initial));

        const content = createElement('div', 'post-content');
        const meta = createElement('div', 'post-meta');
        meta.append(
          createElement('span', 'post-name', name),
          createElement('span', 'post-handle', `@${handle}`),
          createElement('span', 'post-time', '· now')
        );
        if (posts.length > 1) {
          meta.appendChild(createElement('span', 'post-index', `${index + 1}/${posts.length}`));
        }
        content.appendChild(meta);
        content.appendChild(createElement('p', 'post-body', post));

        const footer = createElement('div', 'post-foot');
        footer.appendChild(createCounter(TextMetrics.weight(post)));
        footer.appendChild(createButton('Copy Tweet', 'btn btn-sm', 'copy-post', index));

        const publish = createElement('a', 'btn btn-light btn-sm', 'Publish to X');
        publish.href = 'https://x.com/intent/post?text=' + encodeURIComponent(post);
        publish.target = '_blank';
        publish.rel = 'noopener noreferrer';
        footer.appendChild(publish);
        content.appendChild(footer);

        article.append(rail, content);
        dom.thread.appendChild(article);
      });
    },

    async handlePostClick(event) {
      const button = event.target.closest('button[data-action="copy-post"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      const post = this.state.posts[index];
      if (!post) return;

      const ok = await Clipboard.copy(post);
      if (ok) {
        flashButton(button, 'Copied');
        Toast.show(`Post ${index + 1} copied`);
      } else {
        Toast.show('Copy failed. Select the text and copy it manually.');
      }
    },

    async handleCopyAll() {
      if (!this.state.posts.length) return;
      const ok = await Clipboard.copy(this.state.posts.join(CONFIG.THREAD_SEPARATOR));
      const count = this.state.posts.length;
      Toast.show(ok ? `Full thread copied (${count} ${count === 1 ? 'post' : 'posts'})` : 'Copy failed. Select the text and copy it manually.');
    },
  };

  App.init();
})();
