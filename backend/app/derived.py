# -*- coding: utf-8 -*-
"""派生计算：替代原 Excel 公式列，读取时实时计算"""
from __future__ import annotations


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None


def _cell(data, i):
    return data[i] if i < len(data) else None


def derive_score_rows(rows: list[dict]) -> list[dict]:
    """成绩跟踪：补全 总分月考1/总分期中/进退步"""
    out = []
    for r in rows:
        d = list(r['data'])
        yk = sum(v for i in range(2, 8) if (v := _num(_cell(d, i))) is not None)
        qz = sum(v for i in range(10, 16) if (v := _num(_cell(d, i))) is not None)
        rank1, rank2 = _num(_cell(d, 9)), _num(_cell(d, 17))
        change = rank1 - rank2 if rank1 is not None and rank2 is not None else None
        if yk:
            d[8] = yk
        if qz:
            d[16] = qz
        d[18] = change
        out.append({'row_no': r['row_no'], 'data': d})
    return out


def derive_point_rows(rows: list[dict]) -> list[dict]:
    """日常行为积分：补全 月合计/排名"""
    out = []
    for r in rows:
        d = list(r['data'])
        total = sum(v for i in range(2, 10) if (v := _num(_cell(d, i))) is not None)
        d[10] = int(total) if total else None
        out.append({'row_no': r['row_no'], 'data': d})
    out.sort(key=lambda x: _num(_cell(x['data'], 10)) or 0, reverse=True)
    for i, r in enumerate(out):
        if _num(_cell(r['data'], 10)):
            r['data'][11] = i + 1
    return out


def derive_fund_rows(rows: list[dict]) -> list[dict]:
    """班费管理：补全 余额（收入+/支出-，滚动累计）"""
    out = []
    balance = 0.0
    for r in rows:
        d = list(r['data'])
        t = str(_cell(d, 1) or '').strip()
        amt = _num(_cell(d, 2))
        if amt is not None:
            if '收入' in t:
                balance += amt
            elif '支出' in t:
                balance -= amt
        d[6] = round(balance, 2)
        out.append({'row_no': r['row_no'], 'data': d})
    return out


def derive_weight_rows(rows: list[dict]) -> list[dict]:
    """体重体脂追踪：补全 腰臀比/与上周对比"""
    out = []
    prev_weight = None
    for r in rows:
        d = list(r['data'])
        waist, hip = _num(_cell(d, 5)), _num(_cell(d, 6))
        d[7] = round(waist / hip, 2) if waist and hip else None
        w = _num(_cell(d, 2))
        if w is not None and prev_weight is not None:
            d[8] = round(w - prev_weight, 1)
        prev_weight = w if w is not None else prev_weight
        out.append({'row_no': r['row_no'], 'data': d})
    return out


DERIVERS = {
    '成绩跟踪': derive_score_rows,
    '日常行为积分': derive_point_rows,
    '班费管理': derive_fund_rows,
    '体重体脂追踪': derive_weight_rows,
}


def derive(sheet: str, rows: list[dict]) -> list[dict]:
    fn = DERIVERS.get(sheet)
    return fn(rows) if fn else rows
