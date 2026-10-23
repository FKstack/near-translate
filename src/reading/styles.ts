/** Isolated reading surface; the controller owns content nodes and their lifecycle. */
export const readingStyles = `
.nr-reader .nr-retry:disabled{opacity:.5;cursor:default;text-decoration:none}
:host{all:initial!important;color-scheme:light}
*{box-sizing:border-box}
.nr-reader{
  --nr-bg:#f7f3e9;--nr-panel:#f1ecdf;--nr-text:#293c32;--nr-title:#193b2b;
  --nr-muted:#697163;--nr-faint:#dedbcc;--nr-accent:#28664b;--nr-accent-soft:#e2e9d9;
  --nr-control:#fbf8f0;--nr-hover:#eae7d9;--nr-translated:#315b44;--nr-error:#a13d32;
  --nr-font:Georgia,"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,serif;
  --nr-column:720px;--nr-body-text:var(--nr-text);
  position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;
  width:100%;height:100vh;height:100dvh;overflow:hidden;background:var(--nr-bg);color:var(--nr-text);
  font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  font-synthesis:none;text-align:left;direction:ltr;isolation:isolate;
}
.nr-reader[data-theme=paper]{--nr-bg:#fdfefa;--nr-panel:#f6f7f1;--nr-text:#293a32;--nr-title:#173c29;--nr-muted:#687568;--nr-faint:#dfe5d9;--nr-control:#fff;--nr-hover:#edf1e7;--nr-accent-soft:#e7efdf}
.nr-reader[data-theme=dark]{--nr-bg:#17231e;--nr-panel:#1c2a23;--nr-text:#d7dfd5;--nr-title:#edf2e9;--nr-muted:#a4b1a4;--nr-faint:#35453a;--nr-accent:#a4d0b0;--nr-accent-soft:#304536;--nr-control:#223329;--nr-hover:#2b3e31;--nr-translated:#c2ddc4;--nr-error:#ffb5a5;color-scheme:dark}
.nr-reader[data-font=sans]{--nr-font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}

.nr-reader button,.nr-reader input{font:inherit}
.nr-reader button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;margin:0;padding:0;cursor:pointer;color:inherit;background:transparent;line-height:1.4;-webkit-tap-highlight-color:transparent}
.nr-reader button:disabled{cursor:default;opacity:.5}
.nr-reader button:focus-visible,.nr-reader input:focus-visible,.nr-reader a:focus-visible,.nr-reader summary:focus-visible{outline:2px solid var(--nr-accent);outline-offset:4px}
.nr-reader a{color:var(--nr-accent);text-decoration-thickness:1px;text-underline-offset:3px}
.nr-reader [hidden]{display:none!important}
.nr-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.nr-reader svg{flex:none;width:19px;height:19px}
.nr-header{position:relative;flex:none;background:var(--nr-bg);border-bottom:1px solid var(--nr-faint);z-index:3}
.nr-topbar{height:65px;min-height:65px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 28px;background:var(--nr-bg)}
.nr-brand{display:flex;align-items:center;gap:9px;color:var(--nr-accent);white-space:nowrap;font-size:17px;font-weight:650;letter-spacing:.04em}
.nr-brand svg{width:27px;height:27px}.nr-brand span{color:var(--nr-muted);font-size:13px;letter-spacing:.08em;font-weight:400;border-left:1px solid var(--nr-faint);margin-left:4px;padding-left:13px}
.nr-source{min-width:0;display:flex;align-items:center;gap:8px;margin-right:auto;color:var(--nr-muted);font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nr-source svg{width:14px;height:14px}.nr-source span{overflow:hidden;text-overflow:ellipsis}
.nr-top-actions{display:flex;align-items:center;gap:8px;flex:none}
.nr-local{display:flex;align-items:center;gap:6px;color:var(--nr-muted);font-size:11px;margin-right:15px;white-space:nowrap}
.nr-local i{width:5px;height:5px;border-radius:50%;background:var(--nr-accent)}
.nr-icon-button{width:35px;height:35px;border-radius:7px!important}
.nr-reader .nr-icon-button:hover,.nr-reader .nr-quiet-button:hover{background:var(--nr-hover)}
.nr-reader .nr-icon-button[aria-expanded=true]{background:var(--nr-accent-soft);color:var(--nr-accent)}
.nr-reader .nr-exit{min-height:35px;padding:0 10px 0 12px;border-left:1px solid var(--nr-faint);border-radius:0;margin-left:5px;font-size:12px;color:var(--nr-muted)}
.nr-exit kbd{font:10px/1.4 inherit;padding:1px 4px;border:1px solid var(--nr-faint);border-radius:3px;color:var(--nr-muted)}
.nr-top-progress{position:absolute;bottom:-1px;left:0;height:2px;max-width:100%;background:var(--nr-accent);transform-origin:left;transition:width .18s linear;z-index:2;pointer-events:none}
.nr-layout{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:220px minmax(0,1fr);width:100%}
.nr-reader[data-settings-open=true] .nr-layout{grid-template-columns:220px minmax(0,1fr) 320px}
.nr-outline{min-height:0;display:flex;flex-direction:column;padding:35px 21px 22px 27px;border-right:1px solid var(--nr-faint)}
.nr-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}
.nr-panel-heading h2{margin:0;font-size:12px;letter-spacing:.1em;font-weight:600;color:var(--nr-muted)}
.nr-panel-close{display:none!important}
.nr-outline nav{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;min-height:0;margin:0 -9px 20px;padding:0 9px}
.nr-outline ol{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.nr-reader .nr-outline-item{position:relative;display:block;width:100%;text-align:left;padding:9px 9px 9px 12px;border-radius:5px;color:var(--nr-muted);font-size:12px;line-height:1.65;overflow-wrap:anywhere;transition:background .15s,color .15s}
.nr-outline-item[data-depth="1"]{padding-left:23px;font-size:11px}.nr-outline-item[data-depth="2"]{padding-left:33px;font-size:11px}
.nr-reader .nr-outline-item:hover{background:var(--nr-hover);color:var(--nr-text)}
.nr-reader .nr-outline-item[aria-current=location]{color:var(--nr-accent);background:var(--nr-accent-soft);font-weight:600}
.nr-outline-item[aria-current=location]::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--nr-accent)}
.nr-no-outline{font-size:12px;color:var(--nr-muted);line-height:1.8;margin:0}
.nr-reading-progress{margin-top:auto;padding-top:22px;border-top:1px solid var(--nr-faint);font-size:11px;color:var(--nr-muted)}
.nr-progress-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.nr-progress-label strong{font-size:23px;color:var(--nr-accent);font-weight:400;letter-spacing:-.04em}
.nr-progress-track{height:3px;background:var(--nr-faint);margin:10px 0 12px;overflow:hidden;border-radius:2px}.nr-progress-track span{display:block;height:100%;background:var(--nr-accent);transition:width .18s linear}
.nr-reading-progress p{margin:0}.nr-reading-progress small{display:block;margin-top:4px;font-size:10px;opacity:.8}
.nr-scroll{overflow-anchor:none;min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--nr-faint) transparent;scroll-behavior:smooth;scroll-padding-top:38px}
.nr-paper{max-width:calc(var(--nr-column) + 96px);margin:0 auto;padding:0 48px 70px;min-width:0}
.nr-reading-tools{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px}
.nr-segmented{display:inline-flex;align-items:center;border:1px solid var(--nr-faint);border-radius:7px;padding:3px;gap:2px;background:var(--nr-control)}
.nr-reader .nr-segmented button{min-height:30px;padding:0 12px;border-radius:4px;font-size:11px;white-space:nowrap;color:var(--nr-muted)}
.nr-reader .nr-segmented button:hover{background:var(--nr-hover);color:var(--nr-text)}
.nr-reader .nr-segmented button[aria-pressed=true]{background:var(--nr-accent-soft);color:var(--nr-accent);font-weight:600}
.nr-translate-controls{display:flex;align-items:center;gap:10px;flex:none}
.nr-reader .nr-translate-button{min-height:36px;padding:0 13px;border-radius:6px;background:var(--nr-accent);color:var(--nr-bg);font-size:12px;font-weight:550;letter-spacing:.02em}
.nr-reader .nr-translate-button:hover:not(:disabled){filter:brightness(1.1)}
.nr-reader .nr-translate-button:disabled{background:var(--nr-accent-soft);color:var(--nr-accent);opacity:1}
.nr-translate-button svg{width:16px;height:16px}
.nr-reader .nr-retry{font-size:11px;text-decoration:underline;text-underline-offset:3px;color:var(--nr-accent);padding:5px 0}
.nr-translation-note{display:flex;align-items:flex-start;gap:7px;margin:0;padding:9px 28px 11px;color:var(--nr-muted);font-size:11px;line-height:1.7;border-top:1px solid var(--nr-faint);position:relative}
.nr-translation-note>span{min-width:0;overflow-wrap:anywhere}.nr-translation-note>.nr-retry{flex:none;margin-left:auto}
.nr-translation-note svg{margin-top:2px;width:13px;height:13px}.nr-translation-note[data-tone=error]{color:var(--nr-error)}
.nr-translation-note strong{font-weight:550}.nr-mode-note{margin:9px 0 0;font-size:11px;line-height:1.7;color:var(--nr-muted)}
.nr-translation-meter{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--nr-faint);overflow:hidden}.nr-translation-meter span{height:100%;display:block;background:var(--nr-accent);transition:width .2s}
.nr-article-heading{padding:53px 0 32px;margin-bottom:31px;border-bottom:1px solid var(--nr-faint)}
.nr-eyebrow{font-size:10px;letter-spacing:.15em;color:var(--nr-accent);text-transform:uppercase;margin:0 0 19px;display:flex;align-items:center;gap:9px}.nr-eyebrow::before{content:"";width:19px;height:1px;background:currentColor}
.nr-article-heading h1{margin:0;color:var(--nr-title);font-family:var(--nr-font);font-weight:650;font-size:clamp(29px,2.7vw,43px);line-height:1.32;letter-spacing:-.025em;text-wrap:balance;overflow-wrap:anywhere}
.nr-byline{display:flex;align-items:center;flex-wrap:wrap;gap:7px 11px;margin:22px 0 0;font-size:11px;color:var(--nr-muted);line-height:1.7}.nr-byline i{width:2px;height:2px;background:var(--nr-muted);border-radius:50%}.nr-byline strong{font-weight:500;color:var(--nr-text)}
.nr-content{font-family:var(--nr-font);font-size:var(--nr-font-size,20px);line-height:var(--nr-line-height,1.85);overflow-wrap:break-word;color:var(--nr-body-text,var(--nr-text));text-rendering:optimizeLegibility;letter-spacing:var(--nr-letter-spacing,0);word-spacing:var(--nr-word-spacing,0);text-align:var(--nr-text-align,start)}
.nr-content>:first-child{margin-top:0}.nr-content>:last-child{margin-bottom:0}
.nr-content :where(p,ul,ol,dl,blockquote,pre,figure,table){margin:0 0 var(--nr-paragraph-spacing,1.35em)}.nr-content :where(ul,ol){padding-inline-start:1.45em}.nr-content li{margin-bottom:.38em}.nr-content li>:last-child{margin-bottom:0}
.nr-content :where(h1,h2,h3,h4,h5,h6){color:var(--nr-title);font-family:var(--nr-font);font-weight:650;line-height:1.45;letter-spacing:-.015em;margin:2em 0 .85em;scroll-margin-top:38px;text-wrap:pretty}
.nr-content h1{font-size:1.65em}.nr-content h2{font-size:1.4em}.nr-content h3{font-size:1.17em}.nr-content :where(h4,h5,h6){font-size:1em}
.nr-content strong{font-weight:650}.nr-content :where(img,video){display:block;max-width:100%;height:auto;margin:1.5em auto;border-radius:3px}.nr-content picture{display:block}.nr-content figure{max-width:100%;margin-inline:0}.nr-content figcaption{font:11px/1.8 system-ui,sans-serif;text-align:center;color:var(--nr-muted);margin-top:-.65em}
.nr-content blockquote{padding:.2em 0 .2em 1.15em;margin-inline:0;border-left:2px solid var(--nr-accent);color:var(--nr-muted)}.nr-content blockquote>:last-child{margin-bottom:0}
.nr-content pre{overflow-x:auto;max-width:100%;padding:20px 23px;background:var(--nr-panel);border:1px solid var(--nr-faint);border-radius:5px;line-height:1.7;tab-size:4;white-space:pre;word-wrap:normal;overflow-wrap:normal;font-size:.72em}
.nr-content code{font-family:"Cascadia Code",Consolas,"SFMono-Regular",monospace;font-size:.8em;font-weight:400;letter-spacing:0}.nr-content :not(pre)>code{padding:.1em .28em;background:var(--nr-panel);border-radius:3px}.nr-content pre code{font-size:1em;background:none;padding:0}
.nr-content table{display:block;width:max-content;min-width:0;max-width:100%;overflow-x:auto;border-collapse:collapse;border-spacing:0;font-size:.8em;line-height:1.7}.nr-content :where(th,td){padding:12px 16px;border:1px solid var(--nr-faint);text-align:left;min-width:100px;max-width:400px}.nr-content th{font-weight:600;background:var(--nr-panel)}.nr-content caption{font-size:.9em;color:var(--nr-muted);margin-bottom:12px;text-align:left}
.nr-content hr{border:0;border-top:1px solid var(--nr-faint);margin:2.4em 0}.nr-content :where(sup,sub){font-size:.7em;line-height:0}.nr-content mark{color:inherit;background:var(--nr-accent-soft)}
.nr-content [data-near-reader-translation]{display:block;margin:.6em 0 1em;padding-left:.9em;border-left:2px solid var(--nr-faint);color:var(--nr-translated);white-space:pre-wrap;font-size:calc(1em * var(--nr-translation-scale,1))}
.nr-content[data-mode=original] [data-near-reader-translation]{display:none!important}
.nr-content[data-mode=translation] [data-near-reader-original][data-near-reader-translated=true]{display:none!important}
.nr-content[data-mode=translation] [data-near-reader-translation]{margin:0;padding:0;border:0;color:var(--nr-text)}
.nr-content [data-near-reader-source]{position:relative;transition:opacity .2s}
.nr-content[data-focus=true]:has([data-near-reader-focused=true]) [data-near-reader-source]{opacity:.4}
.nr-content[data-focus=true]:has([data-near-reader-focused=true]) [data-near-reader-source]:is([data-near-reader-focused=true],:hover,:focus-within){opacity:1}
.nr-content[data-focus=true] [data-near-reader-source]:has([data-near-reader-focused=true]),.nr-content[data-focus=true] [data-near-reader-focused=true] [data-near-reader-source]{opacity:1}
.nr-content [data-near-reader-source-action]{position:absolute;inset-inline-start:-29px;top:3px;width:23px;height:26px;color:var(--nr-muted);border:1px solid var(--nr-faint);border-radius:4px;background:var(--nr-bg);opacity:0;font:11px/1 system-ui,sans-serif;transition:opacity .15s}
.nr-content [data-near-reader-source]:is(:hover,:focus-within)>[data-near-reader-source-action],.nr-content [data-near-reader-source-action]:focus-visible{opacity:1}.nr-content [data-near-reader-source-action] svg{width:13px;height:13px}
.nr-article-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:55px;padding-top:23px;border-top:1px solid var(--nr-faint);font-size:11px;color:var(--nr-muted)}
.nr-article-footer p{margin:0;display:flex;align-items:center;gap:7px}.nr-article-footer svg{width:15px;height:15px}.nr-reader .nr-text-button{font-size:11px;color:var(--nr-accent);white-space:nowrap;padding:6px 0}.nr-reader .nr-text-button:hover{text-decoration:underline;text-underline-offset:3px}
.nr-settings{display:none;min-height:0;overflow-y:auto;overscroll-behavior:contain;background:var(--nr-panel);border-left:1px solid var(--nr-faint);padding:28px 22px 25px;scrollbar-width:thin}
.nr-reader[data-settings-open=true] .nr-settings{display:block}.nr-settings .nr-panel-heading{margin-bottom:23px}
.nr-setting{border:0;padding:0;margin:0 0 27px;min-width:0}.nr-setting legend,.nr-setting-label{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:0;margin:0 0 13px;font-size:11px;font-weight:550;color:var(--nr-text)}.nr-setting-label output{font-size:10px;font-weight:400;color:var(--nr-muted)}
.nr-themes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.nr-reader .nr-theme{display:flex;flex-direction:column;gap:7px;font-size:10px;color:var(--nr-muted);border:1px solid transparent;border-radius:6px;padding:5px 3px 7px}.nr-reader .nr-theme:hover{background:var(--nr-hover)}.nr-reader .nr-theme[aria-pressed=true]{border-color:var(--nr-accent);color:var(--nr-accent);background:var(--nr-accent-soft)}
.nr-theme-swatch{width:39px;height:36px;display:grid;place-items:center;font:19px/1 Georgia,serif;border:1px solid #00000016;border-radius:3px}.nr-theme-swatch[data-theme=paper]{background:#fdfefa;color:#293a32}.nr-theme-swatch[data-theme=sepia]{background:#f7f3e9;color:#293c32}.nr-theme-swatch[data-theme=dark]{background:#17231e;color:#e8eee4}
.nr-font-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.nr-reader .nr-font-option{display:flex;flex-direction:column;gap:4px;padding:10px 3px 9px;border:1px solid var(--nr-faint);border-radius:5px;color:var(--nr-muted);background:var(--nr-control);font-size:10px}.nr-font-option strong{font-size:20px;font-weight:500}.nr-font-option[data-font=serif] strong{font-family:Georgia,"Songti SC",SimSun,serif}.nr-font-option[data-font=sans] strong{font-family:system-ui,sans-serif}.nr-reader .nr-font-option[aria-pressed=true]{border-color:var(--nr-accent);color:var(--nr-accent);background:var(--nr-accent-soft)}
.nr-font-stepper{display:grid;grid-template-columns:32px minmax(0,1fr) 32px;align-items:center;gap:11px}.nr-reader .nr-step{width:32px;height:31px;border:1px solid var(--nr-faint);border-radius:5px;font:17px/1 Georgia,serif;background:var(--nr-control);color:var(--nr-text)}.nr-reader .nr-step:hover:not(:disabled){background:var(--nr-hover)}
.nr-reader input[type=range]{appearance:none;display:block;width:100%;height:20px;margin:3px 0;border-radius:3px;background:linear-gradient(var(--nr-faint),var(--nr-faint)) center/100% 3px no-repeat;accent-color:var(--nr-accent);cursor:pointer;outline-offset:6px}.nr-reader input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border-radius:50%;background:var(--nr-accent);border:2px solid var(--nr-panel);box-shadow:0 0 0 1px var(--nr-accent)}.nr-reader input[type=range]::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:var(--nr-accent);border:2px solid var(--nr-panel)}
.nr-widths{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.nr-reader .nr-width{display:flex;flex-direction:column;gap:6px;padding:8px 2px;border:1px solid var(--nr-faint);border-radius:5px;font-size:10px;background:var(--nr-control);color:var(--nr-muted)}.nr-reader .nr-width[aria-pressed=true]{border-color:var(--nr-accent);background:var(--nr-accent-soft);color:var(--nr-accent)}.nr-width svg{width:25px;height:19px}
.nr-focus-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:23px;border-top:1px solid var(--nr-faint)}.nr-focus-setting strong{display:block;font-size:11px;font-weight:550}.nr-focus-setting small{display:block;margin-top:5px;color:var(--nr-muted);font-size:10px;line-height:1.7}
.nr-reader .nr-switch{flex:none;justify-content:flex-start;width:31px;height:18px;padding:3px;border-radius:20px;background:var(--nr-faint)}.nr-switch span{height:12px;width:12px;background:var(--nr-muted);border-radius:50%;transition:transform .15s}.nr-reader .nr-switch[aria-checked=true]{background:var(--nr-accent)}.nr-switch[aria-checked=true] span{background:var(--nr-bg);transform:translateX(13px)}
.nr-settings-footnote{display:flex;align-items:flex-start;gap:7px;margin:30px 0 0;font-size:10px;line-height:1.8;color:var(--nr-muted)}.nr-settings-footnote svg{width:13px;height:13px;margin-top:3px}

/* Reading recipes are a starting point; fine controls stay close to the article. */
.nr-reader[data-theme=contrast]{--nr-bg:#0b0d0c;--nr-panel:#151916;--nr-text:#fff;--nr-title:#fff;--nr-muted:#e0e8df;--nr-faint:#69776c;--nr-accent:#ffe08a;--nr-accent-soft:#333321;--nr-control:#151916;--nr-hover:#282e27;--nr-translated:#f0f5ed;--nr-error:#ffc8bb;color-scheme:dark}
@media(prefers-color-scheme:dark){.nr-reader[data-theme=system]{--nr-bg:#17231e;--nr-panel:#1c2a23;--nr-text:#d7dfd5;--nr-title:#edf2e9;--nr-muted:#a4b1a4;--nr-faint:#35453a;--nr-accent:#a4d0b0;--nr-accent-soft:#304536;--nr-control:#223329;--nr-hover:#2b3e31;--nr-translated:#c2ddc4;--nr-error:#ffb5a5;color-scheme:dark}}
.nr-reader[data-theme=system]{color-scheme:light dark}
.nr-content :where(pre,code,kbd,samp){letter-spacing:0;word-spacing:0;text-align:start}
.nr-reader[data-code-wrap=true] .nr-content pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.nr-reader[data-code-wrap=true] .nr-content pre code{white-space:inherit}
.nr-reader[data-translation-style=card] .nr-content[data-mode=bilingual] [data-near-reader-translation]{padding:.7em .85em;border:1px solid var(--nr-faint);border-radius:6px;background:var(--nr-panel)}
.nr-reader[data-translation-style=plain] .nr-content[data-mode=bilingual] [data-near-reader-translation]{padding-left:0;border:0}
.nr-settings-content{min-width:0}
.nr-setting-hint{font-size:10px;line-height:1.8;color:var(--nr-muted);margin:10px 0 0}
.nr-setting-tag{font-size:9px;font-weight:400;color:var(--nr-muted);letter-spacing:0}
.nr-presets{display:grid;gap:7px}
.nr-reader .nr-preset{display:flex;justify-content:flex-start;gap:10px;width:100%;padding:10px 11px;border:1px solid var(--nr-faint);border-radius:8px;background:var(--nr-control);text-align:left;transition:background .15s,border-color .15s}
.nr-reader .nr-preset:hover{background:var(--nr-hover)}
.nr-reader .nr-preset[aria-pressed=true]{border-color:var(--nr-accent);background:var(--nr-accent-soft)}
.nr-preset-art{display:flex;flex:none;flex-direction:column;justify-content:center;gap:4px;width:31px;height:37px;padding:7px 5px;border-radius:3px;background:#f7f3e9;border:1px solid #b7baaa;color:#566c57}
.nr-preset-art i{height:2px;background:currentColor;width:100%;opacity:.7}.nr-preset-art i:last-child{width:65%}
.nr-preset[data-preset=technical] .nr-preset-art{background:#fdfefa;color:#355445}
.nr-preset[data-preset=technical] .nr-preset-art i{height:1px}
.nr-preset[data-preset=night] .nr-preset-art{background:#17231e;color:#d7dfd5;border-color:#637a68}
.nr-preset-copy{display:grid;gap:3px;min-width:0;flex:1}
.nr-preset-copy strong{font-size:12px;font-weight:600;color:var(--nr-text)}
.nr-preset-copy>span{font-size:10px;line-height:1.6;color:var(--nr-muted);overflow-wrap:anywhere}
.nr-preset-check{display:grid;place-items:center;flex:none;width:15px;height:15px;border:1px solid var(--nr-faint);border-radius:50%;font-size:10px;line-height:1;color:var(--nr-accent)}
.nr-preset[aria-pressed=true] .nr-preset-check{background:var(--nr-accent);border-color:var(--nr-accent);color:var(--nr-bg)}
.nr-theme-swatch[data-theme=system]{background:linear-gradient(90deg,#fdfefa 50%,#17231e 50%);color:#819c88}
.nr-theme-swatch[data-theme=contrast]{background:#0b0d0c;color:#fff;border-color:#69776c}
.nr-settings-details{margin:0 0 26px;border-top:1px solid var(--nr-faint);border-bottom:1px solid var(--nr-faint)}
.nr-settings-details summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;padding:14px 0;font-size:11px;font-weight:550;color:var(--nr-text);line-height:1.6}
.nr-settings-details summary::-webkit-details-marker{display:none}
.nr-settings-details summary>span{font-weight:400;font-size:9px;color:var(--nr-muted);margin-left:auto}
.nr-settings-details summary::after{content:"+";font-size:16px;line-height:1;font-weight:400;color:var(--nr-muted);margin-left:3px}
.nr-settings-details[open] summary::after{content:"−"}
.nr-details-body{padding:3px 0 16px}
.nr-details-body .nr-setting:last-child{margin-bottom:0}
.nr-custom-colors:not([open]){margin-top:-12px}
.nr-custom-colors .nr-setting-hint{margin-top:0;margin-bottom:13px}
.nr-color-fields{display:grid;gap:10px}
.nr-color-field{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:var(--nr-text)}
.nr-color-value{display:flex;align-items:center;gap:8px}
.nr-color-value code{font:10px/1.5 Consolas,monospace;letter-spacing:.02em;color:var(--nr-muted);width:54px}
.nr-reader input[type=color]{appearance:none;display:block;width:32px;height:26px;padding:2px;border:1px solid var(--nr-faint);border-radius:4px;background:var(--nr-control);cursor:pointer}
.nr-reader input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.nr-reader input[type=color]::-webkit-color-swatch{border:0;border-radius:2px}
.nr-contrast-note{display:grid;gap:3px;margin:15px 0 0;font-size:10px;line-height:1.8;color:var(--nr-muted)}
.nr-contrast-note strong{font-weight:550;color:var(--nr-text)}
.nr-contrast-note[data-warning=true]{color:var(--nr-error)}
.nr-reader .nr-secondary-button{min-height:33px;padding:6px 9px;border:1px solid var(--nr-faint);border-radius:5px;background:var(--nr-control);font-size:10px;color:var(--nr-text);text-align:center}
.nr-reader .nr-secondary-button:hover:not(:disabled){background:var(--nr-hover);border-color:var(--nr-accent)}
.nr-reader .nr-contrast-fix{margin-top:10px;width:100%}
.nr-choice-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px}
.nr-reader .nr-choice-row button{min-height:33px;padding:7px 4px;border:1px solid var(--nr-faint);border-radius:5px;background:var(--nr-control);font-size:10px;color:var(--nr-muted)}
.nr-reader .nr-choice-row button[aria-pressed=true]{border-color:var(--nr-accent);color:var(--nr-accent);background:var(--nr-accent-soft)}
.nr-translation-choices button{flex-direction:column}
.nr-translation-sample{display:block;width:25px;height:17px;background:repeating-linear-gradient(to bottom,transparent 0,transparent 3px,currentColor 3px,currentColor 4px,transparent 4px,transparent 7px);opacity:.8}
.nr-translation-sample[data-style=line]{border-left:2px solid currentColor;padding-left:3px;background-origin:content-box;background-clip:content-box}
.nr-translation-sample[data-style=card]{border:1px solid currentColor;border-radius:3px;outline:3px solid var(--nr-accent-soft);outline-offset:-4px}
.nr-toggle-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 22px}
.nr-toggle-setting strong{display:block;font-size:11px;font-weight:550}.nr-toggle-setting small{display:block;margin-top:4px;color:var(--nr-muted);font-size:10px;line-height:1.7}
.nr-settings-divider{height:1px;background:var(--nr-faint);margin:0 0 22px}
.nr-personal-style{margin-top:25px;padding:17px 0 0;border-top:1px solid var(--nr-faint)}
.nr-personal-heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.nr-personal-heading strong{font-size:11px;font-weight:600}.nr-personal-heading>span{font-size:9px;color:var(--nr-muted)}
.nr-personal-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.nr-style-files{display:flex;align-items:center;gap:9px;margin-top:7px;color:var(--nr-muted);font-size:10px}.nr-reader .nr-style-files .nr-text-button{font-size:10px}.nr-file-feedback{margin:5px 0 0;font-size:10px;line-height:1.8;color:var(--nr-accent)}.nr-file-feedback[data-tone=error]{color:var(--nr-error)}.nr-file-feedback[data-tone=info]{color:var(--nr-muted)}
.nr-settings-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px}
.nr-reader .nr-settings-actions .nr-text-button{font-size:10px}
.nr-save-status{margin-top:19px;padding-top:15px;border-top:1px solid var(--nr-faint);font-size:10px;line-height:1.8;color:var(--nr-muted)}
.nr-save-status p{display:flex;align-items:center;gap:6px;margin:0}
.nr-save-status>span{display:block;margin:3px 0 0 11px}
.nr-save-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--nr-accent)}
.nr-save-status[data-status=saving] .nr-save-dot{background:var(--nr-muted)}
.nr-save-status[data-status=error] p{color:var(--nr-error)}
.nr-save-status[data-status=error] .nr-save-dot{background:var(--nr-error)}
.nr-save-status .nr-secondary-button{margin-top:9px;width:100%}
.nr-small-screen,.nr-toc-trigger,.nr-scrim,.nr-mobile-progress{display:none!important}
@media(min-width:1600px){.nr-topbar{padding-inline:34px}.nr-layout,.nr-reader[data-settings-open=true] .nr-layout{grid-template-columns:240px minmax(0,1fr)}.nr-reader[data-settings-open=true] .nr-layout{grid-template-columns:240px minmax(0,1fr) 340px}.nr-outline{padding-left:34px}.nr-settings{padding-inline:28px}}
@media(max-width:1180px){
  .nr-large-screen{display:none!important}.nr-small-screen{display:inline-flex!important}
  .nr-layout,.nr-reader[data-settings-open=true] .nr-layout{grid-template-columns:195px minmax(0,1fr)}
  .nr-outline{padding-left:21px;padding-right:16px}.nr-paper{padding-inline:42px;max-width:calc(var(--nr-column) + 84px)}
  .nr-settings,.nr-reader[data-settings-open=true] .nr-settings{display:none;position:absolute;z-index:5;top:0;right:0;bottom:0;width:340px;max-width:92vw;box-shadow:-8px 0 28px #00000012;padding-top:25px}
  .nr-settings[data-mobile-open=true],.nr-reader[data-settings-open=true] .nr-settings[data-mobile-open=true]{display:block}
  .nr-settings .nr-panel-close{display:inline-flex!important}
  .nr-scrim[data-panel=settings]{display:block!important;position:absolute;inset:0;z-index:4;background:#101c1647;width:100%;height:100%}
  .nr-local{margin-right:8px}.nr-topbar{gap:20px}
}
@media(max-width:860px){
  .nr-topbar{height:auto;min-height:65px;flex-wrap:wrap;padding:12px 19px;gap:12px 16px}.nr-source{display:none}.nr-brand{margin-right:auto}.nr-brand span{font-size:12px}.nr-local{display:none}
  .nr-reading-tools{order:3;flex-basis:100%;width:100%}.nr-translation-note{padding-inline:19px}
  .nr-layout,.nr-reader[data-settings-open=true] .nr-layout{display:block;position:relative}.nr-scroll{height:100%;width:100%}
  .nr-outline{display:none;position:absolute;z-index:5;left:0;top:0;bottom:0;width:min(290px,84vw);padding:25px 22px;background:var(--nr-bg);box-shadow:8px 0 28px #00000012}
  .nr-outline[data-mobile-open=true]{display:flex}.nr-outline .nr-panel-close{display:inline-flex!important}.nr-toc-trigger{display:inline-flex!important}
  .nr-scrim[data-panel=outline]{display:block!important;position:absolute;inset:0;z-index:4;background:#101c1647;width:100%;height:100%}
  .nr-paper{padding:0 36px 55px;max-width:calc(var(--nr-column) + 72px)}.nr-article-heading{padding-top:43px}.nr-article-heading h1{font-size:clamp(29px,4.8vw,40px)}
  .nr-mobile-progress{display:block!important;margin:0;font-size:10px;color:var(--nr-muted)}
}
@media(max-width:520px){
  .nr-topbar{padding-inline:13px;gap:8px}.nr-brand{font-size:15px;gap:6px}.nr-brand svg{width:24px;height:24px}.nr-brand span{display:none}.nr-top-actions{gap:3px}.nr-reader .nr-exit{padding-left:8px;padding-right:2px;margin-left:3px;gap:4px}.nr-exit kbd{display:none}
  .nr-icon-button{width:34px;height:38px}.nr-paper{padding-inline:25px;padding-bottom:45px}.nr-reading-tools{gap:10px}.nr-reader .nr-segmented button{min-height:31px;padding-inline:10px}.nr-reader .nr-translate-button{min-height:34px;padding-inline:10px;font-size:11px;gap:5px}.nr-translate-controls{gap:8px}
  .nr-translation-note{padding-inline:13px}.nr-translate-controls .nr-retry{max-width:72px;font-size:10px}
  .nr-article-heading{padding-top:34px;padding-bottom:24px;margin-bottom:26px}.nr-eyebrow{margin-bottom:14px;font-size:9px}.nr-article-heading h1{font-size:30px;line-height:1.38}.nr-byline{margin-top:17px;font-size:10px;gap:5px 8px}.nr-translation-note,.nr-mode-note{font-size:10px}
  .nr-content pre{padding:16px;font-size:.67em}.nr-content :where(th,td){padding:10px 12px}.nr-content [data-near-reader-source-action]{inset-inline-start:-23px;width:19px}
  .nr-article-footer{margin-top:38px;padding-top:18px;align-items:flex-start}.nr-article-footer p{font-size:10px}.nr-article-footer .nr-text-button{font-size:10px}
  .nr-settings,.nr-reader[data-settings-open=true] .nr-settings{width:min(340px,92vw)}
}
@media(prefers-reduced-motion:reduce){.nr-reader *{transition:none!important;scroll-behavior:auto!important}}
@media print{
  :host{color-scheme:light!important}.nr-reader{position:static!important;display:block!important;height:auto!important;overflow:visible!important;background:#fff!important;color:#111!important}
  .nr-header,.nr-topbar,.nr-top-progress,.nr-outline,.nr-settings,.nr-reading-tools,.nr-translation-note,.nr-mode-note,.nr-translation-meter,.nr-article-footer,.nr-scrim,.nr-content [data-near-reader-source-action]{display:none!important}
  .nr-layout,.nr-scroll{display:block!important;overflow:visible!important;height:auto!important;width:100%!important}.nr-paper{max-width:none!important;padding:0!important;margin:0!important}
  .nr-article-heading{padding-top:0!important}.nr-article-heading h1{font-size:25pt!important;color:#111!important}.nr-content{font-size:12pt!important;color:#111!important}.nr-content [data-near-reader-source]{opacity:1!important}
  .nr-content :where(h1,h2,h3,h4,h5,h6){break-after:avoid;color:#111!important}.nr-content :where(p,li,blockquote){orphans:3;widows:3}.nr-content :where(img,figure,pre,table){break-inside:avoid}.nr-content pre{white-space:pre-wrap!important;overflow:visible!important}.nr-content table{display:table!important;max-width:100%!important;width:100%!important}.nr-content a{color:#111!important}.nr-content [data-near-reader-translation]{color:#222!important}
}
`;
