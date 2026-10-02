# -*- coding: utf-8 -*-
import re
src = open('德州扑克.html', encoding='utf-8').read()
i = src.find('window.HOLDEM = {')
j = src.index('{', i)
depth = 0
for k in range(j, len(src)):
    if src[k] == '{': depth += 1
    elif src[k] == '}':
        depth -= 1
        if depth == 0: end = k; break
seg = src[j+1:end]
# 顶层键：缩进 2 空格 或 以逗号/newline 分隔
tops = re.findall(r'\n  ([A-Za-z_$][\w$]*)\s*:', seg)
print('HOLDEM 顶层出口数:', len(tops))
print('样例:', tops[:12])

# 教练页签
print('教练页签:', re.findall(r'data-tab="(\w+)"', src))
# 局部/全局函数数
print('function 数:', len(re.findall(r'\n\s*(?:async\s+)?function\s+\w+', src)))
print('CSS 规则数 ≈', src[:src.find('</style>')].count('{'))
