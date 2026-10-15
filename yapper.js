/**
 * Yapper bot SDK, one file, no dependencies. Node 18+, Bun and Deno.
 *
 *   import { Bot } from './yapper.js';
 *   const bot = new Bot(process.env.YAPPER_BOT_TOKEN);
 *   bot.command('ping', 'Check the bot is alive', (msg) => msg.reply('pong'));
 *   bot.on('message', (msg) => { if (msg.mentioned) msg.reply('hi!'); });
 *   bot.on('member_join', (ev) => bot.send(ev.channel_id, `welcome <@${ev.user_id}>`));
 *   bot.start();
 *
 * Nothing to host: the bot fetches its own events from Yapper (long polling), so it runs on your PC.
 * Docs: https://www.yapper.website/developers
 */
export class Bot {
  /** @param {string} token from Settings → Developer  @param {{ base?: string, prefixes?: string[], log?: boolean }} [opts] */
  constructor(token, opts = {}) {
    if (!token || !String(token).startsWith('yb_')) throw new Error('Pass your bot token (starts with yb_). Get one in Settings → Developer.');
    this.token = String(token).trim();
    this.base = (opts.base || 'https://www.yapper.website/api/bot/v1').replace(/\/$/, '');
    this.prefixes = opts.prefixes || ['/', '!'];
    this.log = opts.log !== false;
    this.handlers = {};
    this.commands = new Map();
    this.last = 0;
    this.running = false;
    this.me = null;
  }

  /** Listen for an event: "message", "member_join", "member_leave", "test", "ready", "error". */
  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }

  /** Register a command. People type /name or !name; the composer suggests it. */
  command(name, description, fn) {
    if (typeof description === 'function') { fn = description; description = ''; }
    const n = String(name).toLowerCase().replace(/^[/!]/, '');
    if (!/^[a-z0-9_-]{1,32}$/.test(n)) throw new Error(`Bad command name "${name}": letters, numbers, - and _ only`);
    this.commands.set(n, { description: String(description || '').slice(0, 100), fn });
    return this;
  }

  /** Raw API call. `api('GET', '/servers')`, `api('POST', '/channels/<id>/messages', { content: 'hi' })`. */
  async api(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json', 'user-agent': 'yapper-sdk/1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(out.error || `${method} ${path} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return out;
  }

  /** Send a message to a channel. Returns the message. */
  async send(channelId, content, opts = {}) {
    const out = await this.api('POST', `/channels/${channelId}/messages`, { content: String(content), reply_to: opts.replyTo });
    return out.message;
  }
  /** Delete one of the bot's own messages. */
  async delete(channelId, messageId) { return this.api('DELETE', `/channels/${channelId}/messages/${messageId}`); }
  /** Servers the bot is in. */
  async servers() { return (await this.api('GET', '/servers')).servers; }
  /** Channels of a server. */
  async channels(serverId) { return (await this.api('GET', `/servers/${serverId}/channels`)).channels; }
  /** Members of a server (first 200; pass `after` = last user id for more). */
  async members(serverId, after) { return (await this.api('GET', `/servers/${serverId}/members?limit=200${after ? `&after=${after}` : ''}`)).members; }
  /** Recent messages in a channel, oldest first. */
  async messages(channelId, limit = 50) { return (await this.api('GET', `/channels/${channelId}/messages?limit=${limit}`)).messages; }
  /** Someone's public profile. */
  async user(userId) { return (await this.api('GET', `/users/${userId}`)).user; }

  async emit(event, payload) {
    for (const fn of this.handlers[event] || []) {
      try { await fn(payload); } catch (e) { await this.fail(e); }
    }
  }
  async fail(e) {
    if (this.handlers.error?.length) await this.emit('error', e);
    else if (this.log) console.error('[yapper]', e?.message || e);
  }

  /** Register the commands with Yapper and start fetching events. Resolves when stopped. */
  async start() {
    if (this.running) return;
    this.running = true;
    this.me = await this.api('GET', '/me');
    const list = [...this.commands].map(([name, c]) => ({ name, description: c.description }));
    await this.api('PUT', '/commands', { commands: list });
    // Skip events from before we started.
    const first = await this.api('GET', '/events?after=0&wait=0');
    this.last = first.last || 0;
    if (this.log) console.log(`[yapper] ${this.me.username} is online${list.length ? ` with ${list.length} command${list.length === 1 ? '' : 's'}` : ''}`);
    await this.emit('ready', this.me);
    let failures = 0;
    while (this.running) {
      let out;
      try {
        out = await this.api('GET', `/events?after=${this.last}&wait=25`);
        failures = 0;
      } catch (e) {
        failures++;
        if (e.status === 401) { await this.fail(new Error('Token rejected: make a new one in Settings → Developer')); this.running = false; break; }
        await this.fail(e);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
        continue;
      }
      for (const ev of out.events || []) {
        this.last = ev.id;
        await this.handle(ev);
      }
    }
  }

  /** Stop after the current poll. */
  stop() { this.running = false; }

  async handle(ev) {
    const data = ev.data || {};
    if (ev.type === 'message') {
      const msg = this.wrap(data);
      let name = data.command;
      let args = data.args;
      if (!name) {
        // Commands typed with another prefix, or ones we didn't register.
        const m = /^(\S)([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i.exec(data.content || '');
        if (m && this.prefixes.includes(m[1]) && this.commands.has(m[2].toLowerCase())) { name = m[2].toLowerCase(); args = (m[3] || '').trim(); }
      }
      if (name && this.commands.has(name)) {
        msg.command = name;
        msg.args = args || '';
        msg.argv = msg.args ? msg.args.split(/\s+/) : [];
        try { await this.commands.get(name).fn(msg); } catch (e) { await this.fail(e); }
        await this.emit('command', msg);
      }
      await this.emit('message', msg);
    } else {
      await this.emit(ev.type, { ...data, type: ev.type });
    }
  }

  wrap(data) {
    const bot = this;
    return {
      ...data,
      /** Reply to this message (quoted). */
      reply(content) { return bot.send(data.channel_id, content, { replyTo: data.id }); },
      /** Post in the same channel without quoting. */
      say(content) { return bot.send(data.channel_id, content); },
      /** <@id> for the author, for mentioning them back. */
      get authorMention() { return `<@${data.author_id}>`; },
    };
  }
}

export default Bot;
