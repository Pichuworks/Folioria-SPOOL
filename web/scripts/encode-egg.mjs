#!/usr/bin/env node
// Encode easter egg payload. Run:  node web/scripts/encode-egg.mjs > web/src/easter/payload.ts

const KEY = 'crisiris'

function xorEncode(text, key) {
  const tb = new TextEncoder().encode(text)
  const kb = new TextEncoder().encode(key)
  const out = new Uint8Array(tb.length)
  for (let i = 0; i < tb.length; i++) out[i] = tb[i] ^ kb[i % kb.length]
  let bin = ''
  for (const b of out) bin += String.fromCharCode(b)
  return btoa(bin)
}

const e = (s) => xorEncode(s, KEY)

// ── Star message characters (ordered by 入住顺序) ──

const CHARS = [
  {
    id:'raincandy', n:'糸柳雨', f:'糸柳', g:'雨', d:'阿雨', x:1,
    q:'Dm9 → Gmaj7',
    m:'……你怎么找到这里的？？？算了。既然来了……别走太快。我们家挺吵的。但是挺暖的。……才没有在对你撒娇；；',
    c:'#B54857', sp:0.8, pc:0.35, pd:[2,5], bh:3,
    dl:['笨蛋','困了','陪我玩'],
  },
  {
    id:'eri', n:'高桥绘理', f:'高桥', g:'绘理', d:'绘理', x:1,
    q:'E♭maj7',
    m:'欢迎。厨房还有热水，毯子在沙发上。你看起来走了很远的路。在这里歇一下吧。',
    c:'#A03040', sp:0.7, pc:0.4, pd:[3,6], bh:2.5,
    dl:['喝茶吗','bonne nuit'],
  },
  {
    id:'mutsumi', n:'若叶睦', f:'若叶', g:'睦', d:'睦子', x:1,
    q:'A → D → F♯',
    m:'……花。今天也开了。',
    c:'#779977', sp:0.5, pc:0.5, pd:[3,7], bh:2,
    dl:['黄瓜'],
  },
  {
    id:'mortis', n:'Mortis', f:'', g:'Mortis', d:'Mortis', x:1,
    q:'空弦 → 第七弦',
    m:'哼——少爷的秘密被你翻到了。那你也算半个家里人了。进来吧。别碰小睦的黄瓜。',
    c:'#4A5A6A', sp:0.6, pc:0.4, pd:[2,5], bh:2.5,
    dl:['小睦'],
  },
  {
    id:'sakiko', n:'丰川祥子', f:'丰川', g:'祥子', d:'小祥', x:1,
    q:'Amaj7',
    m:'你找到这个地方了呢。说明你很仔细。茶壶还热着。要是不赶时间的话——坐一会儿？',
    c:'#7799CC', sp:0.7, pc:0.4, pd:[3,6], bh:2.5,
    dl:['Amaj7','睦……'],
  },
  {
    id:'nyamu', n:'祐天寺若麦', f:'祐天寺', g:'若麦', d:'喵梦', x:1,
    q:'♩ ♩ ♩ ♩',
    m:'哇——！！你找到了！！大家快来！！有客人！！喵梦亲就知道这里会被发现的！！因为好的地方藏不住嘛！！欢迎欢迎！！！',
    c:'#AA4477', sp:1.4, pc:0.15, pd:[1,3], bh:4,
    dl:['喵梦亲！！'],
  },
  {
    id:'soyo', n:'长崎素世', f:'长崎', g:'素世', d:'素世', x:1,
    q:'Fmaj7 → Em7 → Dm7 → Cmaj7',
    m:'……你来了。没关系。慢慢看就好。这里的故事，每个人走进来的速度都不一样。',
    c:'#FFDD88', sp:0.5, pc:0.5, pd:[4,8], bh:2,
    dl:['…神明给我的礼物'],
  },
  {
    id:'tomori', n:'高松灯', f:'高松', g:'灯', d:'灯', x:1,
    q:'Em11',
    m:'……你也……迷路了？然后……走到这里了？……嗯。……这里很安全。',
    c:'#77BBDD', sp:0.4, pc:0.55, pd:[3,7], bh:2,
    dl:['一辈子…'],
  },
  {
    id:'anon', n:'千早爱音', f:'千早', g:'爱音', d:'爱音', x:1,
    q:'→ Dadd9',
    m:'啊——被发现了！等一下让我拍一张。不对先别动。光线刚好。好——可以了。欢迎！',
    c:'#FF8899', sp:0.9, pc:0.3, pd:[2,4], bh:3,
    dl:['再拍一张'],
  },
  {
    id:'raana', n:'要乐奈', f:'要', g:'乐奈', d:'乐奈', x:1,
    q:'.',
    m:'……。\n……抹茶芭菲。',
    c:'#77DD77', sp:0.3, pc:0.6, pd:[5,10], bh:2,
    dl:['抹茶芭菲','有趣'],
  },
  {
    id:'taki', n:'椎名立希', f:'椎名', g:'立希', d:'立希', x:0,
    q:'///',
    m:'进来就进来，别在门口站着。……茶在桌上。自己拿。',
    c:'#7777AA', sp:0.7, pc:0.35, pd:[2,5], bh:2.5,
    dl:['……'],
  },
  {
    id:'uika', n:'三角初华', f:'三角', g:'初华', d:'初华', x:1,
    q:'hello!',
    m:'欢迎！进来进来！今天天气很好呢。大家都在。',
    c:'#BB9955', sp:0.9, pc:0.3, pd:[2,4], bh:3,
    dl:['来看星星！'],
  },
  {
    id:'umiri', n:'八幡海铃', f:'八幡', g:'海铃', d:'海铃', x:0,
    q:'—',
    m:'嗯。',
    c:'#5588AA', sp:0.5, pc:0.5, pd:[4,8], bh:2,
    dl:[],
  },
  {
    id:'keke', n:'唐可可', f:'唐', g:'可可', d:'可可', x:1,
    q:'KEKE IS HERE!!',
    m:'可可超级欢迎你！！这里是大家的家！！可可第一次来的时候也很紧张！！但是大家都很温柔！！所以你也不要紧张！！快进来——！！',
    c:'#49BDF0', sp:1.3, pc:0.2, pd:[1,3], bh:3.5,
    dl:['命运！！','快来！！'],
  },
  {
    id:'kanon', n:'涩谷香音', f:'涩谷', g:'香音', d:'香音', x:1,
    q:'drive safe!',
    m:'你好。我也是被可可拉来的。后来发现这里意外地舒服。要一起喝杯茶吗？',
    c:'#FF7F27', sp:0.8, pc:0.3, pd:[2,5], bh:2.5,
    dl:['不错呢'],
  },
  {
    id:'ren', n:'叶月恋', f:'叶月', g:'恋', d:'恋', x:1,
    q:'♪',
    m:'难得有客人呢。请。随意就好。',
    c:'#4466BB', sp:0.6, pc:0.45, pd:[3,6], bh:2,
    dl:['请'],
  },
  {
    id:'shiki', n:'若菜四季', f:'若菜', g:'四季', d:'四季', x:1,
    q:'E-B',
    m:'有趣。你是怎么找到入口的？在所有可能的字符串组合中，你输入了正确的那一个。这个概率值得记录。',
    c:'#90CCAA', sp:0.7, pc:0.4, pd:[2,5], bh:2.5,
    dl:['有趣'],
  },
  {
    id:'rina', n:'天王寺璃奈', f:'天王寺', g:'璃奈', d:'璃奈', x:1,
    q:'[>v<]',
    m:'……欢迎。……板子上画不下想说的话。但是。……这个表情是开心的意思。',
    c:'#D4859A', sp:0.6, pc:0.4, pd:[2,5], bh:2.5,
    dl:['[>v<]'],
  },
  {
    id:'sumire', n:'平安名堇', f:'平安名', g:'堇', d:'堇', x:0,
    q:'Aurora',
    m:'……我才没有特意来迎接你。只是刚好路过。……快进去吧。外面冷。',
    c:'#74F466', sp:0.8, pc:0.35, pd:[2,5], bh:2.5,
    dl:['才没有'],
  },
  {
    id:'chisato', n:'岚千砂都', f:'岚', g:'千砂都', d:'千砂都', x:0,
    q:'☀',
    m:'堇其实等了很久哦。啊我说漏嘴了。欢迎！',
    c:'#FF6E90', sp:1.0, pc:0.25, pd:[1,3], bh:3,
    dl:['堇~'],
  },
  {
    id:'mana', n:'纯田真奈', f:'纯田', g:'真奈', d:'真奈', x:1,
    q:'◯',
    m:'……空着手，不太会敲门。所以带了咖啡。虽然最后谁都没喝。但是门，开了。',
    c:'#E8A68F', sp:0.7, pc:0.4, pd:[3,6], bh:2.5,
    dl:['甜甜圈'],
  },
  {
    id:'kkun', n:'佐藤圭介', f:'佐藤', g:'圭介', d:'K君', x:0,
    q:'LOG',
    m:'客人！！请进请进！！大哥不在的话我先招待——啊大哥在。那我去泡茶！！',
    c:'#40A85C', sp:1.1, pc:0.2, pd:[1,3], bh:3,
    dl:['大哥！'],
  },
  {
    id:'koharu', n:'佐藤小春', f:'佐藤', g:'小春', d:'小春', x:0,
    q:'🌸',
    m:'欢迎来到 CrisIris。K 有点吵，不好意思。我帮你倒杯水。',
    c:'#E8C088', sp:0.7, pc:0.35, pd:[2,5], bh:2.5,
    dl:['没事的'],
  },
  {
    id:'shion', n:'都筑诗船', f:'都筑', g:'诗船', d:'诗船', x:0,
    q:'silence',
    m:'——来了啊。坐吧。那边有个位子。',
    c:'#A27997', sp:0.5, pc:0.45, pd:[3,7], bh:2,
    dl:[],
  },
  {
    id:'master', n:'Master', f:'', g:'Master', d:'Master', x:0,
    q:'♨',
    m:'哦。……又来了一位。今天的豆子是危地马拉安提瓜。苦中带甜。合不合口味喝完再说。',
    c:'#6F4E37', sp:0.4, pc:0.5, pd:[4,8], bh:2,
    dl:[],
  },
  {
    id:'melon', n:'香瓜', f:'', g:'香瓜', d:'香瓜', x:0,
    q:'🐱',
    m:'喵。',
    c:'#A08060', sp:0.9, pc:0.3, pd:[1,4], bh:2, cat:1,
    dl:['喵'],
  },
]

// ── Final message (望) ──

const FINAL = {
  n:'星街望', f:'星街', g:'望',
  q:'A, D, F♯',
  m:'这里是阿佐谷。CrisIris。Folioria。名字很多，但指的都是同一个地方。门一直开着。',
}

// ── Cats (pixel stage only, no star messages) ──

const CATS = [
  { id:'watermelon',     d:'西瓜',   c:'#E8883C', c2:null,     op:0.55, sp:1.0, pc:0.25, pd:[1,3], bh:2, dl:['喵'] },
  { id:'watermelon_ice', d:'西瓜冰', c:'#E8883C', c2:'#F0EDE8', op:1,   sp:0.7, pc:0.35, pd:[2,5], bh:2, dl:['喵'] },
  { id:'flatwhite',      d:'澳白',   c:'#F0EDE8', c2:'#A07858', op:1,   sp:0.6, pc:0.4,  pd:[3,6], bh:2, dl:['喵'] },
  { id:'kamaboko',       d:'鱼板',   c:'#F0E6D8', c2:'#6B5044', op:1,   sp:0.5, pc:0.5,  pd:[3,7], bh:1.5, dl:['喵'] },
]

// ── Pair interactions ──

const PAIR_IX = [
  // Core pairs (high chance, short cooldown)
  { a:'mortis',  b:'mutsumi', ad:'小睦，走慢一点',         bd:'……Mortis。',        ch:0.3,  cd:8  },
  { a:'sakiko',  b:'mutsumi', ad:'睦……今天也很好看。',     bd:'……祥。',          ch:0.3,  cd:8  },
  { a:'keke',    b:'kanon',   ad:'香音！！一起散步！！',     bd:'好好好，别拉了可可',  ch:0.3,  cd:8  },
  { a:'sumire',  b:'chisato', ad:'……千砂都别跟这么近',     bd:'堇~一起走嘛',        ch:0.3,  cd:8  },
  { a:'kkun',    b:'koharu',  ad:'小春！那边有星星！',      bd:'K，小声点……',       ch:0.3,  cd:8  },
  { a:'tomori',  b:'anon',    ad:'……爱音。',              bd:'灯！来拍一张！',      ch:0.3,  cd:8  },
  // MyGO intra-band (medium chance)
  { a:'tomori',  b:'soyo',    ad:'……素世。',              bd:'灯……在这里。',       ch:0.2,  cd:12 },
  { a:'tomori',  b:'taki',    ad:'……立希。',              bd:'……走吧。',          ch:0.2,  cd:12 },
  { a:'tomori',  b:'raana',   ad:'……乐奈。',             bd:'……。',              ch:0.2,  cd:12 },
  { a:'anon',    b:'soyo',    ad:'素世！笑一个！',         bd:'……好。',            ch:0.2,  cd:12 },
  { a:'anon',    b:'taki',    ad:'立希，看镜头！',         bd:'……不要。',          ch:0.2,  cd:12 },
  { a:'taki',    b:'raana',   ad:'……',                   bd:'……有趣。',          ch:0.2,  cd:12 },
  { a:'soyo',    b:'raana',   ad:'乐奈……要芭菲吗？',     bd:'……抹茶芭菲。',          ch:0.2,  cd:12 },
  // Ave Mujica related
  { a:'mutsumi', b:'uika',    ad:'……初华。',             bd:'睦！一起看星星！',    ch:0.2,  cd:12 },
  { a:'sakiko',  b:'mortis',  ad:'Mortis……泡茶吗？',     bd:'祥子，看前面。',  ch:0.2,  cd:12 },
  { a:'mutsumi', b:'umiri',   ad:'……海铃。',             bd:'嗯。',              ch:0.2,  cd:12 },
  // Liella related
  { a:'keke',    b:'ren',     ad:'恋！！跳舞！！',         bd:'……这里？',          ch:0.2,  cd:12 },
  { a:'kanon',   b:'sumire',  ad:'堇，那边有花呢',         bd:'……我才没有在看花。', ch:0.2,  cd:12 },
  { a:'kanon',   b:'ren',     ad:'恋，晚上好',            bd:'嗯，晚上好。',       ch:0.2,  cd:12 },
  { a:'chisato', b:'kanon',   ad:'香音~今天也辛苦了',      bd:'千砂都也是',         ch:0.2,  cd:12 },
  { a:'keke',    b:'sumire',  ad:'堇！！',                bd:'……吵死了。',        ch:0.2,  cd:12 },
  // Cross-group
  { a:'nyamu',   b:'anon',    ad:'爱音！！拍喵梦亲！！',    bd:'好可爱！不要动！',    ch:0.15, cd:15 },
  { a:'nyamu',   b:'keke',    ad:'可可！！一起跑！！',      bd:'跑！！！',           ch:0.15, cd:15 },
  { a:'shiki',   b:'rina',    ad:'璃奈，这个概率很有趣',   bd:'[>v<]',             ch:0.15, cd:15 },
  { a:'raincandy',     b:'eri',     ad:'绘理……有热水吗',        bd:'在厨房。来。',       ch:0.15, cd:15 },
  { a:'raincandy',     b:'mortis',  ad:'Mortis你又偷吃',        bd:'冤枉啊qwq',         ch:0.15, cd:15 },
  // Café
  { a:'mana',    b:'master',  ad:'……咖啡。',             bd:'今天的豆子，试试？',  ch:0.1,  cd:20 },
  { a:'eri',     b:'master',  ad:'Master，还有热水吗',     bd:'壶里有。',           ch:0.1,  cd:20 },
  { a:'koharu',  b:'master',  ad:'Master，加一杯。',       bd:'好。',              ch:0.1,  cd:20 },
  { a:'shion',   b:'master',  ad:'——',                   bd:'老样子？',           ch:0.1,  cd:20 },
  // Cross-group (continued)
  { a:'raincandy', b:'nyamu',   ad:'喵梦别闹了！',          bd:'阿雨脸红了！！',     ch:0.15, cd:15 },
  { a:'nyamu',     b:'mutsumi', ad:'小睦！！♡',             bd:'……喵梦。',          ch:0.15, cd:15 },
  { a:'sakiko',    b:'uika',    ad:'初华……♡',              bd:'小祥！看看那颗星！', ch:0.15, cd:15 },
  { a:'sakiko',    b:'soyo',    ad:'素世……喝茶吗？',        bd:'……好。谢谢小祥。', ch:0.15, cd:15 },
  { a:'mortis',    b:'raana',   ad:'.',                     bd:'……。',             ch:0.1,  cd:20 },
  { a:'keke',      b:'soyo',    ad:'素世！！一起唱！',       bd:'……可可真有精神。',  ch:0.15, cd:15 },
  { a:'ren',       b:'eri',     ad:'……绘理。茶？',          bd:'好呢。坐吧。',        ch:0.1,  cd:20 },
  { a:'rina',      b:'mutsumi', ad:'[>v<]',                 bd:'……璃奈的板子。',    ch:0.15, cd:15 },
  { a:'eri',       b:'sakiko',  ad:'祥子，辛苦了。',         bd:'……绘理姐姐也是。',      ch:0.15, cd:15 },
]

// ── Cat interactions ──

const CAT_IX = [
  { cat:'melon', tgt:'raincandy',     td:'香瓜别跑！！',     ch:0.3,  cd:8  },
  { cat:'*',     tgt:'mutsumi', td:'……猫。',          ch:0.25, cd:10 },
  { cat:'melon', tgt:'mortis',  td:'……香瓜，下来。',   ch:0.2,  cd:12 },
  { cat:'melon', tgt:'nyamu',   td:'香瓜！！喵——！！', ch:0.25, cd:10 },
  { cat:'*',     tgt:'eri',     td:'小心别踩到猫。',    ch:0.15, cd:15 },
  { cat:'*',     tgt:'tomori',  td:'……毛茸茸的。',     ch:0.2,  cd:12 },
  { cat:'*',     tgt:'raana',   td:'……猫。有趣。',     ch:0.15, cd:15 },
  { cat:'*',     tgt:'sakiko',  td:'……猫。……♡',      ch:0.2,  cd:12 },
  { cat:'*',     tgt:'soyo',    td:'……♡',            ch:0.15, cd:15 },
  { cat:'*',     tgt:'anon',    td:'猫！！不要动！',   ch:0.2,  cd:12 },
  { cat:'*',     tgt:'keke',    td:'猫！！！',         ch:0.2,  cd:12 },
  { cat:'*',     tgt:'rina',    td:'[^.^]',           ch:0.15, cd:15 },
  { cat:'*',     tgt:'taki',    td:'……♡',            ch:0.1,  cd:20 },
  { cat:'*',     tgt:'uika',    td:'小猫~♡',          ch:0.2,  cd:12 },
  { cat:'*',     tgt:'kkun',    td:'猫！？',           ch:0.2,  cd:12 },
  { cat:'*',     tgt:'mana',    td:'……猫……',         ch:0.15, cd:15 },
]

// ── Solo actions ──

const SOLO = [
  { id:'raana',     ty:'long_pause',  dl:[] },
  { id:'nyamu',     ty:'sprint',      dl:['！！'] },
  { id:'tomori',    ty:'big_bounce',  dl:[] },
  { id:'raincandy', ty:'sequence',    dl:['……','！','……'] },
  { id:'eri',       ty:'pause',       dl:['♡'] },
  { id:'mortis',    ty:'turn',        dl:['♪'] },
  { id:'sakiko',    ty:'pause',       dl:['♪'] },
  { id:'soyo',      ty:'pause',       dl:['…'] },
  { id:'anon',      ty:'pause',       dl:['📷'] },
  { id:'taki',      ty:'pause',       dl:[] },
  { id:'uika',      ty:'pause',       dl:['✦'] },
  { id:'umiri',     ty:'pause',       dl:[] },
  { id:'keke',      ty:'spin',        dl:['！！！'] },
  { id:'shiki',     ty:'sequence',    dl:['？','！'] },
  { id:'rina',      ty:'pause',       dl:['[>v<]'] },
  { id:'mana',      ty:'pause',       dl:[] },
  { id:'kkun',      ty:'sequence',    dl:['？','！'] },
  { id:'koharu',    ty:'pause',       dl:['♡'] },
  { id:'melon',     ty:'cat_antics',  dl:[] },
]

// ── Group events ──

const GROUP = [
  { ty:'cats_stop',       ch:0.0002, cd:30 },
  { ty:'volume_warning',  ch:0.0003, cd:30 },
  { ty:'crychic',         ch:0.0005, cd:45 },
  { ty:'mygo',            ch:0.0005, cd:45 },
  { ty:'meeting',         ch:0.0003, cd:40 },
]

// ── Tagline + hint ──

const TAGLINE = ['Crisamielle Aveniris', 'Folia Impressa Animae']
const HINT = 'この場所を知っている人へ。\n致那些了解这里的人。'

// ── Build encoded payload ──

const s = CHARS.map(ch => ({
  i: ch.id,
  n: e(ch.n),
  f: e(ch.f),
  g: e(ch.g),
  d: e(ch.d),
  x: ch.x,
  q: e(ch.q),
  m: e(ch.m),
  c: ch.c,
}))

const b = {}
for (const ch of CHARS) {
  b[ch.id] = {
    sp: ch.sp, pc: ch.pc, pd: ch.pd, bh: ch.bh,
    dl: ch.dl.map(l => e(l)),
    ...(ch.cat ? { cat: 1 } : {}),
  }
}

const z = {
  n: e(FINAL.n), f: e(FINAL.f), g: e(FINAL.g),
  q: e(FINAL.q), m: e(FINAL.m),
}

const k = CATS.map(cat => ({
  i: cat.id,
  d: e(cat.d),
  c: cat.c, c2: cat.c2, op: cat.op,
  sp: cat.sp, pc: cat.pc, pd: cat.pd, bh: cat.bh,
  dl: cat.dl.map(l => e(l)),
}))

const t = TAGLINE.map(l => e(l))
const h = e(HINT)

const ix = PAIR_IX.map(r => ({
  a: r.a, b: r.b,
  ad: e(r.ad), bd: e(r.bd),
  ch: r.ch, cd: r.cd,
}))

const cx = CAT_IX.map(r => ({
  cat: r.cat, tgt: r.tgt,
  td: e(r.td),
  ch: r.ch, cd: r.cd,
}))

const so = SOLO.map(r => ({
  id: r.id,
  ty: r.ty,
  dl: (r.dl || []).map(l => e(l)),
}))

const payload = { s, z, t, h, b, k, ix, cx, so, ge: GROUP }

// ── Output ──

console.log('// @generated by encode-egg.mjs — do not hand-edit')
console.log('// Re-generate: node web/scripts/encode-egg.mjs > web/src/easter/payload.ts')
console.log('export const _d = ' + JSON.stringify(payload))
