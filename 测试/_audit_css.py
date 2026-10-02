# -*- coding: utf-8 -*-
import re
src = open('德州扑克.html', encoding='utf-8').read()
lines = src.split('\n')
css = '\n'.join(lines[6:991])
js  = '\n'.join(lines[1655:9018])

css_cls = set(re.findall(r'\.([A-Za-z][\w-]*)', css))

js_cls = set()
for m in re.finditer(r'class=\\?["\']([^"\'\\]+)', js):
    for c in m.group(1).split():
        js_cls.add(c)
for m in re.finditer(r'classList\.(?:add|remove|toggle|contains)\(\s*["\']([\w-]+)["\']', js):
    js_cls.add(m.group(1))

js_cls = {c for c in js_cls if re.match(r'^[A-Za-z][\w-]*$', c)}
missing = sorted(c for c in js_cls if c not in css_cls)
print('JS 用到但 CSS 未定义的类（%d）:' % len(missing))
for c in missing:
    n = len(re.findall(r'[\s"\']' + re.escape(c) + r'[\s"\'\\.]', js))
    print('  .' + c, '-> JS 出现约', n, '次')

print('\n== KIND_CN / allKinds ==')
i = js.find('KIND_CN')
print(js[i-60:i+700])
