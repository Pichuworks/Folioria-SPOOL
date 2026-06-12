import { useEffect, useState, type ReactNode } from 'react'
import { fetchOptions, type OptionsDto } from './api'

/* Asagaya modern·杂志版式 × eri 配色。家具：墨标签节头 / 撕样条 / 点线引导行 / 竖排引文 / 对折页码 */

const MagSec = ({ n, title, id, children }: { n: string; title: string; id?: string; children: ReactNode }) => (
  <section id={id} className="pt-13">
    <div className="mb-[22px] flex items-center gap-3.5 border-b border-ink pb-3">
      <span className="bg-ink px-2.5 py-1 font-mono text-[11px] tracking-[.22em] text-paper">{n}</span>
      <h2 className="text-[26px] font-semibold text-ink">{title}</h2>
    </div>
    {children}
  </section>
)

const Leader = () => <span className="mx-2.5 flex-1 -translate-y-1 border-b border-dotted border-line" />

const PillLink = ({ href, kind, children }: { href: string; kind: 'primary' | 'ghost'; children: ReactNode }) => (
  <a
    href={href}
    className={
    kind === 'primary'
      ? 'inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-wine bg-wine px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-cream shadow-e1 transition-opacity hover:opacity-90'
      : 'inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-transparent px-[18px] py-2.5 text-[14px] font-medium tracking-[.02em] text-wine-ink hover:bg-wine-dim/40'
    }
  >
    {children}
  </a>
)

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
  { n: '02', title: '委托确认', body: '与工坊确认文件与工期；在线下单功能即将上线。' },
  { n: '03', title: '审稿与生产', body: '人工预检文件的出血、分辨率与色彩，确认后排产。' },
  { n: '04', title: '交付', body: '按约定自取或寄送，作品以无酸材料衬护包装。' },
]

interface PriceRow {
  label: string
  display: string
}

export default function Home() {
  const [rows, setRows] = useState<PriceRow[] | null>(null)

  useEffect(() => {
    fetchOptions()
      .then((o: OptionsDto) => {
        const mins = o.sizes
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
        setRows(mins.slice(0, 5))
      })
      .catch(() => setRows([]))
  }, [])

  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-[1200px] px-10">
        {/* 刊头 */}
        <header className="flex flex-wrap items-end justify-between gap-x-[18px] gap-y-3 border-b border-ink pb-4 pt-[30px]">
          <div className="flex items-end gap-5">
            <span className="text-[44px] font-bold leading-none tracking-[.04em]">Folioria</span>
            <div className="pb-1">
              <div className="text-[15px] font-medium tracking-[.08em]">印刷工坊</div>
              <div className="font-garamond text-[13px] italic text-dim">Fine Print Atelier</div>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-1 text-[13px]">
            <a href="#craft" className="whitespace-nowrap text-dim hover:text-ink">工艺</a>
            <a href="#paper" className="whitespace-nowrap text-dim hover:text-ink">纸张</a>
            <a href="#price" className="whitespace-nowrap text-dim hover:text-ink">价格</a>
            <a href="#flow" className="whitespace-nowrap text-dim hover:text-ink">流程</a>
            <PillLink href="#/calculator" kind="primary">自助报价</PillLink>
          </nav>
        </header>

        {/* 跨页 hero */}
        <div className="relative overflow-hidden border-b border-ink md:min-h-[430px]">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-[72px] right-20 hidden select-none text-[400px] font-medium leading-none text-transparent opacity-45 [-webkit-text-stroke:1.5px_var(--color-wine)] md:block"
          >
            印
          </span>
          <span className="absolute bottom-9 right-7 top-9 hidden border-l border-line pl-4 text-[15px] tracking-[.42em] text-ink [writing-mode:vertical-rl] lg:block">
            把作品落在纸上，颜色与层次都经得起细看。
          </span>
          <div className="max-w-[560px] py-10 md:absolute md:bottom-11 md:left-0 md:py-0">
            <div className="mb-3.5 font-mono text-[12.5px] tracking-[.3em] text-wine-ink">FOLIORIA · GICLÉE & DIGITAL PRESS</div>
            <h1 className="text-[56px] font-medium leading-[1.15] tracking-[.02em]">
              数字时代的
              <br />
              精细印刷
            </h1>
            <p className="mt-4 text-[16px] leading-[1.85] tracking-[.02em] text-dim">
              从单张微喷到小批量图文，价格由成本模型实时推导——配置即报价，不必询价等待。
            </p>
            <div className="mt-6 flex items-center gap-3">
              <PillLink href="#/calculator" kind="primary">自助报价 →</PillLink>
              <PillLink href="#craft" kind="ghost">了解工艺</PillLink>
            </div>
          </div>
        </div>

        <main className="pb-16">
          <MagSec n="01" title="工艺" id="craft">
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

          <MagSec n="02" title="纸张" id="paper">
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
            <div className="mt-6 w-[300px] border-t border-ink pt-2">
              <p className="text-[10.5px] leading-[1.9] text-dim">
                ※ — 纸张口径与库存以报价页实时数据为准。
              </p>
            </div>
          </MagSec>

          <MagSec n="03" title="价格" id="price">
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
              <PillLink href="#/calculator" kind="primary">进入自助报价 →</PillLink>
              <span className="font-mono text-[10.5px] tracking-[.12em] text-dim">价格由成本模型实时推导 · 配置即报价</span>
            </div>
          </MagSec>

          <MagSec n="04" title="流程" id="flow">
            <div className="grid grid-cols-1 gap-x-8 md:grid-cols-4">
              {STEPS.map((s) => (
                <div key={s.n} className="border-t-2 border-ink pt-3">
                  <span className="font-mono text-[12px] text-wine-ink">{s.n}</span>
                  <h3 className="mt-2 text-[18px] font-medium">{s.title}</h3>
                  <p className="mt-2 text-[12.5px] leading-[1.85] text-dim">{s.body}</p>
                </div>
              ))}
            </div>
          </MagSec>
        </main>

        {/* 对折页码 footer */}
        <footer className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-ink pb-7 pt-3 font-mono text-[10.5px] tracking-[.14em] text-dim">
          <span>FOLIORIA · S.P.O.O.L.</span>
          <span>WWW.FOLIORIA.COM</span>
          <span>
            © 2026 FOLIORIA ·{' '}
            <a href="#/dashboard" className="hover:text-ink">
              STAFF →
            </a>
          </span>
        </footer>
      </div>
    </div>
  )
}
