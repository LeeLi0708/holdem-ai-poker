# -*- coding: utf-8 -*-
import re, json, collections
src = open('德州扑克.html', encoding='utf-8').read()
lines = src.split('\n')
print('总行数', len(lines))

# 段落边界
for tag in ['<style', '</style>', '<body', '</body>', '<script', '</script>']:
    idx = [i+1 for i,l in enumerate(lines) if tag in l]
    print(f'{tag:10s} -> {idx[:6]}')

body = src
# 函数定义
funcs = re.findall(r'\n\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', body)
print('\n== function 定义数 ==', len(funcs), '唯一', len(set(funcs)))
dups = [k for k,v in collections.Counter(funcs).items() if v>1]
print('重名函数:', dups)

arrow = re.findall(r'\n\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>', body)
print('箭头函数常量:', len(arrow))

# window.HOLDEM 出口
m = re.search(r'window\.HOLDEM\s*=\s*\{', src)
print('\n== window.HOLDEM 段 ==', src[:m.start()].count('\n')+1 if m else None)
if m:
    # 找到匹配的右括号
    i = m.end(); depth=1
    while depth>0:
        if src[i]=='{': depth+=1
        elif src[i]=='}': depth-=1
        i+=1
    seg = src[m.end():i-1]
    keys = re.findall(r'([A-Za-z_$][\w$]*)\s*[:,]', seg)
    print('HOLDEM 出口数', len(keys))
    print(keys)

# localStorage 键
ks = sorted(set(re.findall(r"['\"](holdem_[a-z0-9_]+)['\"]", src)))
print('\n== localStorage 键 ==', len(ks))
for k in ks: print(' ', k, src.count(k))

# BACKUP_KEYS
mb = re.search(r'BACKUP_KEYS\s*=\s*\[(.*?)\]', src, re.S)
if mb:
    print('\nBACKUP_KEYS:', re.findall(r"['\"]([^'\"]+)['\"]", mb.group(1)))
