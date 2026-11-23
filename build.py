"""Builds the static site: src/pages/*.html + src/partials -> public/*.html
Each page starts with a meta comment:  <!--meta {"title": "...", "desc": "...", "nav": "home", "viewer": false} -->"""
import json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(ROOT, 'src'), os.path.join(ROOT, 'public')
part = lambda n: open(os.path.join(SRC, 'partials', n), encoding='utf-8').read()
head, header, footer = part('head.html'), part('header.html'), part('footer.html')

VIEWER_HEAD = '<script type="importmap">{ "imports": { "three": "./assets/vendor/three.module.min.js", "three/addons/": "./assets/vendor/addons/" } }</script>'
VIEWER_JS = '<script type="module" src="assets/js/viewer.js"></script>'

for name in sorted(os.listdir(os.path.join(SRC, 'pages'))):
    raw = open(os.path.join(SRC, 'pages', name), encoding='utf-8').read()
    m = re.match(r'\s*<!--meta (.*?)-->\n?', raw, re.S)
    meta = json.loads(m.group(1)); body = raw[m.end():]
    body = re.sub(r'\{\{include:([\w-]+)\}\}', lambda mm: part(mm.group(1) + '.html'), body)
    viewer = meta.get('viewer', False)
    html = (head.replace('{{title}}', meta['title']).replace('{{desc}}', meta['desc'])
                .replace('{{nav}}', meta['nav']).replace('{{headExtra}}', VIEWER_HEAD if viewer else '')
            + header + body + footer.replace('{{scripts}}', VIEWER_JS if viewer else ''))
    # mark the current page in both menus
    html = html.replace(f'data-nav="{meta["nav"]}"', f'data-nav="{meta["nav"]}" aria-current="page"')
    open(os.path.join(OUT, name), 'w', encoding='utf-8').write(html)
    print('built', name)

# ---- portal apps: src/panel/team.html -> public/team/index.html, src/panel/app.html -> public/app/index.html
sprite = header[:header.index('</svg>')]
extra = '''
  <symbol id="i-logout" viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/></symbol>
  <symbol id="i-board" viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></symbol>
  <symbol id="i-store" viewBox="0 0 24 24"><path d="M4 9 5.5 4h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/></symbol>
  <symbol id="i-gauge" viewBox="0 0 24 24"><path d="M4 18a8 8 0 1 1 16 0M12 18l4-6"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17h.01"/></symbol>
  <symbol id="i-dollar" viewBox="0 0 24 24"><path d="M12 3v18M16.5 7.5C16 6 14.3 5 12 5 9.5 5 7.5 6.3 7.5 8.3c0 4.4 9 2.4 9 7 0 2-2 3.4-4.5 3.4-2.4 0-4.2-1.1-4.7-2.8"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></symbol>
  <symbol id="i-note" viewBox="0 0 24 24"><path d="M5 4h14v11l-5 5H5zM14 20v-5h5"/></symbol>
  <symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></symbol>
</svg>'''
os.makedirs(os.path.join(SRC, 'panel'), exist_ok=True)
for app in ('team', 'app'):
    p = os.path.join(SRC, 'panel', app + '.html')
    if not os.path.exists(p): continue
    os.makedirs(os.path.join(OUT, app), exist_ok=True)
    open(os.path.join(OUT, app, 'index.html'), 'w', encoding='utf-8').write(open(p, encoding='utf-8').read().replace('{{sprite}}', sprite + extra))
    print('built', app + '/index.html')
