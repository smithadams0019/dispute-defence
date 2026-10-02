// Two stores with one interface: Memory (tests, local) and Dynamo (deployed).
//   pk = S#<session>   sk = META | D#<dispute id>
//   Open disputes also carry gsi_open="1", gsi_due=<ISO>: the sparse "open-by-due" index the guard sweeps.
//   pk = SYS           sk = BUDGET#<yyyy-mm-dd>   atomic Bedrock call counter

const TTL_DAYS = 10;
export const BEDROCK_DAILY_CAP = Number(process.env.BEDROCK_DAILY_CAP || 400);
const OPEN = new Set(['NEW', 'ANALYSED', 'ESCALATED']);

export class MemoryStore {
  constructor() { this.m = new Map(); this.budget = new Map(); }
  async getMeta(sid) { return this.m.get(sid)?.meta ?? null; }
  async putMeta(sid, meta) { const s = this.m.get(sid) ?? { meta: null, d: new Map() }; s.meta = meta; this.m.set(sid, s); }
  async list(sid) { return [...(this.m.get(sid)?.d.values() ?? [])].map((r) => structuredClone(r)); }
  async get(sid, id) { const r = this.m.get(sid)?.d.get(id); return r ? structuredClone(r) : null; }
  async put(sid, rec, { expect } = {}) {
    const s = this.m.get(sid) ?? { meta: null, d: new Map() };
    const cur = s.d.get(rec.id);
    if (expect !== undefined && (cur?.version ?? 0) !== expect) { const e = new Error('dispute changed underneath this request; reload and retry'); e.status = 409; throw e; }
    rec.version = (cur?.version ?? 0) + 1;
    s.d.set(rec.id, structuredClone(rec)); this.m.set(sid, s);
  }
  async clear(sid) { this.m.delete(sid); }
  async openDue() { const out = []; for (const [sid, s] of this.m) for (const r of s.d.values()) if (OPEN.has(r.state)) out.push({ sid, rec: structuredClone(r) }); return out.sort((a, b) => a.rec.due_at.localeCompare(b.rec.due_at)); }
  async putInbox(e) { (this.inbox ??= []).push(e); }
  async listInbox() { return this.inbox ?? []; }
  async getCache(k) { return this.cache?.get(k) ?? null; }
  async putCache(k, v) { (this.cache ??= new Map()).set(k, structuredClone(v)); }
  async takeBudget(day, n = 1) { const v = (this.budget.get(day) ?? 0) + n; if (v > BEDROCK_DAILY_CAP) return false; this.budget.set(day, v); return true; }
}

export class DynamoStore {
  constructor(table = process.env.TABLE_NAME || 'dispute-defence') { this.table = table; this.ready = this.init(); }
  async init() {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const lib = await import('@aws-sdk/lib-dynamodb');
    this.lib = lib;
    this.doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } });
  }
  ttl() { return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400; }
  async getMeta(sid) { await this.ready; const r = await this.doc.send(new this.lib.GetCommand({ TableName: this.table, Key: { pk: `S#${sid}`, sk: 'META' } })); return r.Item?.doc ?? null; }
  async putMeta(sid, meta) { await this.ready; await this.doc.send(new this.lib.PutCommand({ TableName: this.table, Item: { pk: `S#${sid}`, sk: 'META', doc: meta, ttl: this.ttl() } })); }
  async list(sid) {
    await this.ready;
    const r = await this.doc.send(new this.lib.QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :d)', ExpressionAttributeValues: { ':p': `S#${sid}`, ':d': 'D#' } }));
    return (r.Items ?? []).map((i) => i.doc);
  }
  async get(sid, id) { await this.ready; const r = await this.doc.send(new this.lib.GetCommand({ TableName: this.table, Key: { pk: `S#${sid}`, sk: `D#${id}` } })); return r.Item?.doc ?? null; }
  async put(sid, rec, { expect } = {}) {
    await this.ready;
    const prev = rec.version ?? 0;
    rec.version = prev + 1;
    const item = { pk: `S#${sid}`, sk: `D#${rec.id}`, doc: rec, ttl: this.ttl() };
    if (OPEN.has(rec.state)) { item.gsi_open = '1'; item.gsi_due = rec.due_at; }
    const cond = expect === undefined ? {} : { ConditionExpression: 'attribute_not_exists(pk) OR #d.#v = :v', ExpressionAttributeNames: { '#d': 'doc', '#v': 'version' }, ExpressionAttributeValues: { ':v': expect } };
    try { await this.doc.send(new this.lib.PutCommand({ TableName: this.table, Item: item, ...cond })); }
    catch (e) { rec.version = prev; if (e.name === 'ConditionalCheckFailedException') { const x = new Error('dispute changed underneath this request; reload and retry'); x.status = 409; throw x; } throw e; }
  }
  async clear(sid) {
    await this.ready;
    const r = await this.doc.send(new this.lib.QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `S#${sid}` }, ProjectionExpression: 'pk, sk' }));
    for (const k of r.Items ?? []) await this.doc.send(new this.lib.DeleteCommand({ TableName: this.table, Key: { pk: k.pk, sk: k.sk } }));
  }
  async openDue() {
    await this.ready;
    const out = []; let ExclusiveStartKey;
    do {
      const r = await this.doc.send(new this.lib.QueryCommand({ TableName: this.table, IndexName: 'open-by-due', KeyConditionExpression: 'gsi_open = :o', ExpressionAttributeValues: { ':o': '1' }, ExclusiveStartKey, Limit: 200 }));
      for (const i of r.Items ?? []) out.push({ sid: i.pk.slice(2), rec: i.doc });
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < 2000);
    return out;
  }
  async putInbox(e) { await this.ready; await this.doc.send(new this.lib.PutCommand({ TableName: this.table, Item: { pk: 'SYS', sk: `HOOK#${e.received_at}#${e.id}`, doc: e, ttl: Math.floor(Date.now() / 1000) + 30 * 86400 } })); }
  async listInbox() { await this.ready; const r = await this.doc.send(new this.lib.QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :h)', ExpressionAttributeValues: { ':p': 'SYS', ':h': 'HOOK#' }, Limit: 50, ScanIndexForward: false })); return (r.Items ?? []).map((i) => i.doc); }
  async getCache(k) { await this.ready; const r = await this.doc.send(new this.lib.GetCommand({ TableName: this.table, Key: { pk: 'SYS', sk: `SEED#${k}` } })); return r.Item?.doc ?? null; }
  async putCache(k, v) { await this.ready; await this.doc.send(new this.lib.PutCommand({ TableName: this.table, Item: { pk: 'SYS', sk: `SEED#${k}`, doc: v, ttl: Math.floor(Date.now() / 1000) + 30 * 86400 } })); }
  async takeBudget(day, n = 1) {
    await this.ready;
    try {
      await this.doc.send(new this.lib.UpdateCommand({ TableName: this.table, Key: { pk: 'SYS', sk: `BUDGET#${day}` }, UpdateExpression: 'ADD calls :n SET #t = :ttl', ConditionExpression: 'attribute_not_exists(calls) OR calls <= :max',
        ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':n': n, ':max': BEDROCK_DAILY_CAP - n, ':ttl': this.ttl() } }));
      return true;
    } catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
  }
}
