import { useEffect, useState, type ReactNode } from 'react'
import { AccountMenu } from './Account'
import { fetchOptions, fetchPublicAnnouncements, getOptionsCache, type MeDto, type OptionsDto, type PublicAnnouncementDto } from './api'
import { Leader, MagSec, PillLink, Shell } from './spec'

/* Asagaya modern·杂志版式 × eri 配色。家具：墨标签节头 / 撕样条 / 点线引导行 / 竖排引文 / 对折页码 */

const CRAFTS = [
  {
    kicker: 'PIGMENT · GICLÉE',
    title: '颜料艺术微喷',
    body: '颜料墨水的层次与稳定性，配合棉浆、硫化钡等艺术纸基，适合摄影与插画作品的收藏级输出。',
  },
  {
    kicker: 'LASER · TONER',
    title: '彩色与黑白激光',
    body: '铜版与道林纸上的敏捷输出，从单页文档到小批量图文，色彩一致、交付迅速。',
  },
  {
    kicker: 'PAPER STOCK',
    title: '常备艺术纸库',
    body: '多克重铜版、道林、微喷棉浆与硫化钡常备在库，按作品气质挑选纸面与肌理。',
  },
]

const PAPERS = [
  { name: '打印纸', note: '70G · 文档', color: 'var(--color-card)', width: 28 },
  { name: '道林', note: '80G · 书页质感', color: 'var(--color-cream)', width: 24 },
  { name: '铜版', note: '128–300G · 图文', color: 'var(--color-deep)', width: 22 },
  { name: '微喷棉浆', note: 'COTTON · 艺术微喷', color: 'var(--color-wine-dim)', width: 15 },
  { name: '硫化钡', note: 'BARYTA · 银盐质感', color: 'var(--color-gold)', width: 11 },
]

const STEPS = [
  { n: '01', title: '自助报价', body: '选择工艺、纸张与尺寸，价格即时可见，无需注册。' },
  { n: '02', title: '在线下单', body: '注册并验证邮箱后在线提交订单，逐行上传印刷文件。' },
  { n: '03', title: '审稿与生产', body: '人工预检出血、分辨率与色彩；驳回可改稿重传，确认后排产。' },
  { n: '04', title: '交付', body: '完成后通知取件，按约定自取或寄送，作品以无酸材料衬护包装。' },
]

interface PriceRow {
  label: string
  display: string
}

const minRows = (o: OptionsDto | null): PriceRow[] | null => {
  if (!o) return null
  return o.sizes
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map((s) => {
      let best: { sell_c: number; display: string } | null = null
      for (const opt of o.options) {
        const p = opt.prices[s.key]
        if (p && (best === null || p.sell_c < best.sell_c)) best = p
      }
      return best ? { label: s.label, display: best.display } : null
    })
    .filter((r): r is PriceRow => r !== null)
    .slice(0, 5)
}

export default function Home({ me, nav }: { me: MeDto | null; nav?: ReactNode }) {
  const [rows, setRows] = useState<PriceRow[] | null>(() => minRows(getOptionsCache()))
  const [announcements, setAnnouncements] = useState<PublicAnnouncementDto[]>([])

  useEffect(() => {
    fetchOptions()
      .then((o: OptionsDto) => setRows(minRows(o)))
      .catch(() => setRows((prev) => prev ?? []))
    void fetchPublicAnnouncements().then(setAnnouncements)
  }, [])

  const anchor = 'whitespace-nowrap text-dim hover:text-ink'
  const guestNav = (
    <>
      <a href="#craft" className={anchor}>工艺</a>
      <a href="#paper" className={anchor}>纸张</a>
      <a href="#price" className={anchor}>价格</a>
      <a href="#flow" className={anchor}>流程</a>
      <a href="#/price-list" className={anchor}>价目表</a>
      <PillLink href="#/quote" kind="primary">自助报价</PillLink>
      <AccountMenu me={me} />
    </>
  )
  return (
    <Shell center="WWW.FOLIORIA.COM" nav={nav ?? guestNav}>

        {/* 跨页 hero */}
        <div className="relative overflow-hidden border-b border-ink md:min-h-[430px]">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-[72px] right-20 hidden select-none text-[400px] font-medium leading-none text-transparent opacity-45 [-webkit-text-stroke:1.5px_var(--color-wine)] md:block"
          >
            映
          </span>
          <span className="absolute bottom-9 right-7 top-9 hidden border-l border-line pl-4 text-[15px] tracking-[.42em] text-ink [writing-mode:vertical-rl] lg:block">
            枫林叶下，光影映成。文作入纸，时光刻上。
          </span>
          <div className="max-w-[560px] py-10 md:absolute md:bottom-11 md:left-0 md:py-0">
            <h1 className="text-[38px] font-medium leading-[1.15] tracking-[.18em] md:text-[56px]">
              这里是
              <br />
              <span className="ink-press whitespace-nowrap">枫光映刻</span>
            </h1>
            <p className="mt-4 text-[16px] leading-[1.85] tracking-[.02em] text-dim">
              我们负责把创作纸质化。从一本同人志、一张无料、一套周边，到展会现场的每一份物料，枫光映刻会参与它们从屏幕到纸面的全过程。
            </p>
            <div className="mt-6 flex items-center gap-3">
              <PillLink href="#/quote" kind="primary">自助报价 · 在线下单 →</PillLink>
              <PillLink href="#craft" kind="ghost">了解工艺</PillLink>
            </div>
          </div>
        </div>

        {announcements.length > 0 && (
          <div className="mt-6 flex flex-col gap-3">
            {announcements.map((a) => (
              <div key={a.id} className={`border px-6 py-4 ${a.pinned ? 'border-wine bg-wine-dim/10' : 'border-line'}`}>
                {a.pinned && <div className="mb-1 font-mono text-[10px] tracking-[.18em] text-wine-ink">NOTICE</div>}
                <h3 className="text-[15px] font-medium">{a.title}</h3>
                {a.body && <p className="mt-1.5 text-[13px] leading-[1.85] text-dim">{a.body}</p>}
                <span className="mt-1 block font-mono text-[10px] tracking-[.08em] text-dim">{a.published_at.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )}

        <MagSec title="工艺" id="craft">
            <div className="grid grid-cols-1 border-l border-t border-line md:grid-cols-3">
              {CRAFTS.map((c) => (
                <div key={c.title} className="border-b border-r border-line p-7">
                  <div className="font-mono text-[10.5px] tracking-[.18em] text-dim">{c.kicker}</div>
                  <h3 className="mt-3 text-[22px] font-medium">{c.title}</h3>
                  <p className="mt-3 text-[13.5px] leading-[1.85] text-dim">{c.body}</p>
                </div>
              ))}
            </div>
          </MagSec>

          <MagSec title="纸张" id="paper">
            <div className="flex h-[110px] border border-ink">
              {PAPERS.map((p, i) => (
                <div
                  key={p.name}
                  style={{ width: `${p.width}%`, background: p.color }}
                  className={i < PAPERS.length - 1 ? 'border-r border-ink' : ''}
                />
              ))}
            </div>
            <div className="flex">
              {PAPERS.map((p) => (
                <div key={p.name} style={{ width: `${p.width}%` }} className="pt-2">
                  <div className="mb-1 h-[7px] w-px bg-ink" />
                  <div className="text-[11.5px] font-medium">{p.name}</div>
                  <div className="font-mono text-[10px] tracking-[.05em] text-dim">{p.note}</div>
                </div>
              ))}
            </div>
          </MagSec>

          <MagSec title="价格" id="price">
            {rows === null ? (
              <p className="text-[13px] text-dim">价目加载中…</p>
            ) : rows.length === 0 ? (
              <p className="text-[13px] text-dim">价目暂不可用，请进入自助报价查看实时价格。</p>
            ) : (
              <div>
                {rows.map((r) => (
                  <div key={r.label} className="flex items-baseline gap-3.5 border-b border-line py-[11px]">
                    <span className="min-w-24 text-[15px] font-medium">{r.label}</span>
                    <span className="text-[12.5px] text-dim">单张起</span>
                    <Leader />
                    <span className="font-mono text-[13px] tracking-[.05em] text-wine-ink">{r.display}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-6 flex items-center gap-4">
              <PillLink href="#/quote" kind="primary">进入自助报价 →</PillLink>
              <PillLink href="#/price-list" kind="ghost">完整价目表 →</PillLink>
            </div>
          </MagSec>

        <MagSec title="流程" id="flow">
          <div className="grid grid-cols-1 gap-x-8 gap-y-8 [&>:first-child]:border-t-0 md:grid-cols-4 md:gap-y-0 md:[&>:first-child]:border-t-2">
            {STEPS.map((s) => (
              <div key={s.n} className="border-t-2 border-ink pt-3">
                <span className="font-mono text-[12px] text-wine-ink">{s.n}</span>
                <h3 className="mt-2 text-[18px] font-medium">{s.title}</h3>
                <p className="mt-2 text-[12.5px] leading-[1.85] text-dim">{s.body}</p>
              </div>
            ))}
          </div>
        </MagSec>
    </Shell>
  )
}
