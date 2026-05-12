#!/usr/bin/env python3
"""
markdown2bpmn.py — Markdown から BPMN 2.0 XML を生成するツール
依存: Python 標準ライブラリのみ
使用: python markdown2bpmn.py <input.md> [-o output.bpmn] [--validate] [--verbose]
"""

import re
import sys
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.dom import minidom

# ─────────────────────────────────────────────
# レイアウト定数
# ─────────────────────────────────────────────
TASK_W        = 100
TASK_H        = 80
LANE_H        = 180
STEP_MARGIN   = 160
H_MARGIN      = 160   # bpmn.io 標準 (pool 左端 x)
V_MARGIN      = 40
GW_SIZE       = 50
EVENT_SIZE    = 36
POOL_LABEL_W  = 30
STEP_START    = 110   # レーン左端からの最初のタスク開始オフセット
GW_LABEL_H    = 14    # ゲートウェイラベルの高さ (px)
JP_CHAR_W     = 10    # 日本語1文字あたりの推定幅 (px)


# ─────────────────────────────────────────────
# データモデル
# ─────────────────────────────────────────────
class Lane:
    def __init__(self, lane_id, name, description=""):
        self.id = lane_id
        self.name = name
        self.description = description


class Branch:
    def __init__(self, condition, target):
        self.condition = condition
        self.target = target
        self.is_default = condition.strip() in ("(デフォルト)", "(default)")


class Step:
    def __init__(self, num, lane_id, label):
        self.num = num
        self.lane_id = lane_id
        self.label = label
        self.step_type = "task"          # task | gateway_ex | gateway_par | end
        self.gateway_label = ""
        self.branches = []               # list[Branch]
        self.explicit_next = None        # int | None
        self.is_end = False


class BpmnModel:
    def __init__(self):
        self.process_id   = "process-1"
        self.process_name = "業務プロセス"
        self.version      = "1.0"
        self.author       = ""
        self.purpose      = ""
        self.lanes        = []   # list[Lane]
        self.steps        = []   # list[Step]


# ─────────────────────────────────────────────
# パーサー
# ─────────────────────────────────────────────

def parse_frontmatter(lines):
    meta = {}
    if not lines or lines[0].strip() != "---":
        return meta, lines
    end_idx = None
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return meta, lines
    for line in lines[1:end_idx]:
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta, lines[end_idx + 1:]


def parse_sections(lines):
    sections = {}
    current_key   = None
    current_lines = []
    for line in lines:
        m = re.match(r"^##\s+(.+)", line)
        if m:
            if current_key:
                sections[current_key] = current_lines
            current_key   = m.group(1).strip()
            current_lines = []
        else:
            if current_key:
                current_lines.append(line)
    if current_key:
        sections[current_key] = current_lines
    return sections


def parse_lanes(lane_lines):
    lanes   = []
    pattern = re.compile(r"\*\*(.+?)\*\*\s*\((\w+)\)(?::\s*(.*))?")
    for line in lane_lines:
        m = pattern.search(line)
        if m:
            lanes.append(Lane(m.group(2).strip(), m.group(1).strip(),
                              (m.group(3) or "").strip()))
    return lanes


def parse_flow(flow_lines):
    steps          = []
    step_pattern   = re.compile(r"^(\d+)\.\s+\[(\w+)\]\s+(.+)")
    branch_pattern = re.compile(r"^\s{2,}-\s+(.+?)\s*→\s*(\d+)")
    gw_ex_pattern  = re.compile(r"<GW:\s*(.+?)>")
    gw_par_pattern = re.compile(r"<GW\|\|:\s*(.+?)>")
    end_pattern    = re.compile(r"<END>")
    next_pattern   = re.compile(r"→\s*(\d+)")
    current_step   = None

    for line in flow_lines:
        if re.match(r"^\s*<!--", line):
            continue

        m_step = step_pattern.match(line)
        if m_step:
            num     = int(m_step.group(1))
            lane_id = m_step.group(2)
            label   = m_step.group(3).strip()
            step    = Step(num, lane_id, label)

            m_gw = gw_ex_pattern.search(label)
            if m_gw:
                step.step_type     = "gateway_ex"
                step.gateway_label = m_gw.group(1).strip()
                step.label         = gw_ex_pattern.sub("", label).strip().rstrip("→").strip()

            m_gwp = gw_par_pattern.search(label)
            if m_gwp:
                step.step_type     = "gateway_par"
                step.gateway_label = m_gwp.group(1).strip()
                step.label         = gw_par_pattern.sub("", label).strip().rstrip("→").strip()

            if end_pattern.search(label):
                step.is_end  = True
                step.label   = end_pattern.sub("", label).strip()

            if step.step_type == "task" and not step.is_end:
                m_next = next_pattern.search(step.label)
                if m_next:
                    step.explicit_next = int(m_next.group(1))
                    step.label = next_pattern.sub("", step.label).strip().rstrip("→").strip()

            current_step = step
            steps.append(step)
            continue

        m_branch = branch_pattern.match(line)
        if m_branch and current_step:
            current_step.branches.append(Branch(m_branch.group(1).strip(),
                                                 int(m_branch.group(2))))

    return steps


def validate_model(model, verbose=False):
    errors   = []
    warnings = []
    lane_ids  = {l.id for l in model.lanes}
    step_nums = {s.num for s in model.steps}

    if not model.process_id:
        errors.append("E002: process_id が定義されていません")
    if not model.lanes:
        errors.append("E003: レーンが1つも定義されていません")
    if not model.steps:
        errors.append("E004: フローが1ステップも定義されていません")

    for step in model.steps:
        if step.lane_id not in lane_ids:
            errors.append(f"E005: ステップ {step.num} の lane_id '{step.lane_id}' が未定義です")
        if step.explicit_next and step.explicit_next not in step_nums:
            errors.append(f"E006: ステップ {step.num} の → {step.explicit_next} は存在しないステップ番号です")
        if step.step_type in ("gateway_ex", "gateway_par") and not step.branches:
            warnings.append(f"W001: ステップ {step.num} のゲートウェイに分岐条件がありません")
        for branch in step.branches:
            if branch.target not in step_nums:
                errors.append(f"E006: ステップ {step.num} の分岐先 → {branch.target} は存在しないステップ番号です")

    return errors, warnings


# ─────────────────────────────────────────────
# XML ビルダー (2パス方式)
# ─────────────────────────────────────────────

BPMN   = "http://www.omg.org/spec/BPMN/20100524/MODEL"
BPMNDI = "http://www.omg.org/spec/BPMN/20100524/DI"
DC     = "http://www.omg.org/spec/DD/20100524/DC"
DI_NS  = "http://www.omg.org/spec/DD/20100524/DI"

ET.register_namespace("bpmn",   BPMN)
ET.register_namespace("bpmndi", BPMNDI)
ET.register_namespace("dc",     DC)
ET.register_namespace("di",     DI_NS)
ET.register_namespace("camunda","http://camunda.org/schema/1.0/bpmn")


def bq(tag):   return f"{{{BPMN}}}{tag}"
def diq(tag):  return f"{{{BPMNDI}}}{tag}"
def dcq(tag):  return f"{{{DC}}}{tag}"


# ─── SequenceFlow 収集 ───────────────────────

def collect_flows(model):
    """
    全 SequenceFlow を事前に収集する。
    戻り値: list of dict {id, src, tgt, condition, is_default}
    """
    step_map   = {s.num: s for s in model.steps}
    flows      = []
    added_ids  = set()

    def add(flow_id, src, tgt, condition=None, is_default=False):
        if flow_id not in added_ids:
            flows.append(dict(id=flow_id, src=src, tgt=tgt,
                              condition=condition, is_default=is_default))
            added_ids.add(flow_id)

    # StartEvent → 最初のタスク
    if model.steps:
        first = model.steps[0]
        add(f"Flow_StartEvent_1_Task_{first.num}",
            "StartEvent_1", f"Task_{first.num}")

    for i, step in enumerate(model.steps):
        task_id = f"Task_{step.num}"

        if step.step_type in ("gateway_ex", "gateway_par"):
            gw_id = f"Gateway_{step.num}"
            # タスク → ゲートウェイ
            add(f"Flow_{task_id}_{gw_id}", task_id, gw_id)
            # ゲートウェイ → 各ターゲット
            for branch in step.branches:
                tgt_id  = f"Task_{branch.target}"
                flow_id = f"Flow_{gw_id}_{tgt_id}"
                add(flow_id, gw_id, tgt_id,
                    condition=None if branch.is_default else branch.condition,
                    is_default=branch.is_default)

        elif step.is_end:
            end_id = f"EndEvent_{step.num}"
            add(f"Flow_{task_id}_{end_id}", task_id, end_id)

        elif step.explicit_next:
            tgt_id = f"Task_{step.explicit_next}"
            add(f"Flow_{task_id}_{tgt_id}", task_id, tgt_id)

        else:
            # 次のステップへの自動接続
            next_num = step.num + 1
            if next_num in step_map:
                tgt_id = f"Task_{next_num}"
                add(f"Flow_{task_id}_{tgt_id}", task_id, tgt_id)

    return flows


# ─── XML 構築 ────────────────────────────────

def build_bpmn_xml(model):
    flows    = collect_flows(model)
    step_map = {s.num: s for s in model.steps}

    # outgoing / incoming のインデックスを作る
    outgoing = {}   # elem_id → list[flow_id]
    incoming = {}   # elem_id → list[flow_id]
    for f in flows:
        outgoing.setdefault(f["src"], []).append(f["id"])
        incoming.setdefault(f["tgt"], []).append(f["id"])

    # ─── ルート ───
    # xmlns:* は ET.register_namespace() が自動出力するため重複を避けて除外。
    # camunda 名前空間は拡張要素を使わなくても宣言だけ保持したいため
    # dummy 属性ではなく exporter 属性として記録する方式を採る。
    root = ET.Element(bq("definitions"), {
        "targetNamespace": "http://bpmn.io/schema/bpmn",
        "exporter":        "Markdown2BPMN",
        "exporterVersion": "1.0.0",
        "id":              f"Definitions_{model.process_id}",
    })

    proc_id  = f"Process_{model.process_id}"
    collab_id = "Collaboration_1"
    part_id   = "Participant_1"

    collab = ET.SubElement(root, bq("collaboration"), {"id": collab_id})
    ET.SubElement(collab, bq("participant"), {
        "id": part_id, "name": model.process_name, "processRef": proc_id,
    })

    process = ET.SubElement(root, bq("process"), {
        "id": proc_id, "name": model.process_name, "isExecutable": "false",
    })
    if model.purpose:
        ET.SubElement(process, bq("documentation")).text = model.purpose

    # ─── LaneSet ───
    lane_set   = ET.SubElement(process, bq("laneSet"), {"id": "LaneSet_1"})
    lane_index = {l.id: i for i, l in enumerate(model.lanes)}
    lane_els   = {}   # lane_id → Element

    for lane in model.lanes:
        lane_el = ET.SubElement(lane_set, bq("lane"), {
            "id": f"Lane_{lane.id}", "name": lane.name,
        })
        lane_els[lane.id] = lane_el

    def add_to_lane(lane_id, elem_id):
        el = lane_els.get(lane_id, list(lane_els.values())[0])
        ET.SubElement(el, bq("flowNodeRef")).text = elem_id

    # ─── StartEvent ───
    start_id = "StartEvent_1"
    start_el = ET.SubElement(process, bq("startEvent"), {"id": start_id, "name": "開始"})
    for fid in outgoing.get(start_id, []):
        ET.SubElement(start_el, bq("outgoing")).text = fid
    # StartEvent はフロー最初のレーンに配置
    first_lane = model.steps[0].lane_id if model.steps else model.lanes[0].id
    add_to_lane(first_lane, start_id)

    # ─── Steps ───
    for step in model.steps:
        task_id = f"Task_{step.num}"
        lane_id = step.lane_id

        # タスク要素
        task_el = ET.SubElement(process, bq("userTask"), {"id": task_id, "name": step.label})
        for fid in incoming.get(task_id, []):
            ET.SubElement(task_el, bq("incoming")).text = fid
        for fid in outgoing.get(task_id, []):
            ET.SubElement(task_el, bq("outgoing")).text = fid
        add_to_lane(lane_id, task_id)

        if step.step_type in ("gateway_ex", "gateway_par"):
            gw_id  = f"Gateway_{step.num}"
            gw_tag = "exclusiveGateway" if step.step_type == "gateway_ex" else "parallelGateway"

            # default フローを特定
            default_branch = next((b for b in step.branches if b.is_default), None)
            gw_attrs = {"id": gw_id, "name": step.gateway_label}
            if default_branch and step.step_type == "gateway_ex":
                gw_attrs["default"] = f"Flow_{gw_id}_Task_{default_branch.target}"

            gw_el = ET.SubElement(process, bq(gw_tag), gw_attrs)
            for fid in incoming.get(gw_id, []):
                ET.SubElement(gw_el, bq("incoming")).text = fid
            for fid in outgoing.get(gw_id, []):
                ET.SubElement(gw_el, bq("outgoing")).text = fid
            add_to_lane(lane_id, gw_id)

        elif step.is_end:
            end_id = f"EndEvent_{step.num}"
            end_el = ET.SubElement(process, bq("endEvent"), {"id": end_id, "name": "終了"})
            for fid in incoming.get(end_id, []):
                ET.SubElement(end_el, bq("incoming")).text = fid
            add_to_lane(lane_id, end_id)

        elif not step.explicit_next and step == model.steps[-1]:
            # 最後のステップで is_end が未指定の場合も終了イベントを追加
            end_id = f"EndEvent_{step.num}"
            end_el = ET.SubElement(process, bq("endEvent"), {"id": end_id, "name": "終了"})
            for fid in incoming.get(end_id, []):
                ET.SubElement(end_el, bq("incoming")).text = fid
            add_to_lane(lane_id, end_id)

    # ─── SequenceFlow ───
    for f in flows:
        attrs = {"id": f["id"], "sourceRef": f["src"], "targetRef": f["tgt"]}
        sf_el = ET.SubElement(process, bq("sequenceFlow"), attrs)
        if f.get("condition"):
            ET.SubElement(sf_el, bq("conditionExpression")).text = f["condition"]

    # ─────────────────────────────────────────
    # レイアウト座標計算
    # ─────────────────────────────────────────

    step_x = {}
    cur_x  = H_MARGIN + POOL_LABEL_W + STEP_START

    for step in model.steps:
        step_x[step.num] = cur_x
        if step.step_type in ("gateway_ex", "gateway_par"):
            cur_x += STEP_MARGIN + 80   # タスク + ゲートウェイ分
        else:
            cur_x += STEP_MARGIN

    total_width  = cur_x + H_MARGIN
    total_height = V_MARGIN + len(model.lanes) * LANE_H + V_MARGIN

    # ─── BPMNDiagram ───
    diagram = ET.SubElement(root, diq("BPMNDiagram"), {"id": "Diagram_1"})
    plane   = ET.SubElement(diagram, diq("BPMNPlane"), {
        "id": "Plane_1", "bpmnElement": collab_id,
    })

    # elem_id → (x, y, w, h) の座標記録（waypoint 計算に使用）
    elem_bounds  = {}   # elem_id → (x, y, w, h)
    elem_lane_id = {}   # elem_id → lane_id

    def shape(elem_id, x, y, w, h, lane_id=None, label_text=None,
              label_pos=None, **extra):
        """BPMNShape を追加し、座標を記録する。label_pos は 'below' or 'above'。"""
        attrs = {"id": f"Shape_{elem_id}", "bpmnElement": elem_id}
        attrs.update(extra)
        s = ET.SubElement(plane, diq("BPMNShape"), attrs)
        b = ET.SubElement(s, dcq("Bounds"))
        b.set("x", str(int(x))); b.set("y", str(int(y)))
        b.set("width", str(int(w))); b.set("height", str(int(h)))
        elem_bounds[elem_id] = (int(x), int(y), int(w), int(h))
        if lane_id:
            elem_lane_id[elem_id] = lane_id
        if label_text is not None and label_pos is not None:
            lw = max(int(len(label_text) * JP_CHAR_W), 22)
            lx = int(x + (w - lw) / 2)
            if label_pos == "below":
                ly = int(y + h + 4)
            else:   # above
                ly = int(y - GW_LABEL_H - 6)
            lbl = ET.SubElement(s, diq("BPMNLabel"))
            lb  = ET.SubElement(lbl, dcq("Bounds"))
            lb.set("x", str(lx)); lb.set("y", str(ly))
            lb.set("width", str(lw)); lb.set("height", str(GW_LABEL_H))
        return s

    def _waypoints(src_id, tgt_id):
        """
        SequenceFlow のウェイポイントを自動計算する。
        ルーティング規則:
          同レーン       : 水平直線 (右辺中心 → 左辺中心)
          下レーンへ     : 下辺中心から L字 → 下 → 右 → 左辺中心
          上レーンへ     : 右辺中心から L字 → 右 → 上 → 左辺中心
        """
        if src_id not in elem_bounds or tgt_id not in elem_bounds:
            return []
        sx, sy, sw, sh = elem_bounds[src_id]
        tx, ty, tw, th = elem_bounds[tgt_id]
        s_cx = sx + sw / 2;  s_cy = sy + sh / 2
        t_cx = tx + tw / 2;  t_cy = ty + th / 2

        src_li = lane_index.get(elem_lane_id.get(src_id, ""), 0)
        tgt_li = lane_index.get(elem_lane_id.get(tgt_id, ""), 0)

        if src_li == tgt_li:
            # 同レーン: 水平直線
            return [(sx + sw, s_cy), (tx, t_cy)]
        elif src_li < tgt_li:
            # 下レーンへ: 下辺中心 → L 字
            return [(s_cx, sy + sh), (s_cx, t_cy), (tx, t_cy)]
        else:
            # 上レーンへ: 右辺 → L 字 (右・上・右)
            inter_x = tx - 30
            if inter_x > sx + sw:
                return [(sx + sw, s_cy), (inter_x, s_cy),
                        (inter_x, t_cy), (tx, t_cy)]
            else:
                # ターゲットが近い場合は下辺から入る
                return [(sx + sw, s_cy), (t_cx, s_cy), (t_cx, ty + th)]

    def edge(flow_id, src_id, tgt_id):
        """BPMNEdge を waypoint 付きで追加する。"""
        e = ET.SubElement(plane, diq("BPMNEdge"), {
            "id": f"Edge_{flow_id}", "bpmnElement": flow_id,
        })
        for (wpx, wpy) in _waypoints(src_id, tgt_id):
            wp = ET.SubElement(e, f"{{{DI_NS}}}waypoint")
            wp.set("x", str(int(wpx)))
            wp.set("y", str(int(wpy)))

    # ── Pool ──
    shape(part_id, H_MARGIN, V_MARGIN, total_width, total_height,
          isHorizontal="true")

    # ── Lanes ──
    lx = H_MARGIN + POOL_LABEL_W
    lw = total_width - H_MARGIN - POOL_LABEL_W
    for i, lane in enumerate(model.lanes):
        ly = V_MARGIN + i * LANE_H
        shape(f"Lane_{lane.id}", lx, ly, lw, LANE_H, isHorizontal="true")

    # ── StartEvent ──
    first_step = model.steps[0] if model.steps else None
    if first_step:
        li   = lane_index.get(first_step.lane_id, 0)
        se_x = H_MARGIN + POOL_LABEL_W + 40
        se_y = V_MARGIN + li * LANE_H + (LANE_H - EVENT_SIZE) // 2
        shape(start_id, se_x, se_y, EVENT_SIZE, EVENT_SIZE,
              lane_id=first_step.lane_id,
              label_text="開始", label_pos="below")
        elem_lane_id[start_id] = first_step.lane_id

    # ── Tasks / Gateways / EndEvents ──
    for step in model.steps:
        li   = lane_index.get(step.lane_id, 0)
        x    = step_x[step.num]
        ty_  = V_MARGIN + li * LANE_H + (LANE_H - TASK_H) // 2
        ey_  = V_MARGIN + li * LANE_H + (LANE_H - EVENT_SIZE) // 2
        gwy_ = V_MARGIN + li * LANE_H + (LANE_H - GW_SIZE) // 2

        shape(f"Task_{step.num}", x, ty_, TASK_W, TASK_H,
              lane_id=step.lane_id)

        if step.step_type in ("gateway_ex", "gateway_par"):
            gw_x = x + TASK_W + 60
            shape(f"Gateway_{step.num}",
                  gw_x, gwy_, GW_SIZE, GW_SIZE,
                  lane_id=step.lane_id,
                  label_text=step.gateway_label, label_pos="above",
                  isMarkerVisible="true")

        elif step.is_end or (not step.explicit_next and step == model.steps[-1]):
            end_x = x + TASK_W + 40
            shape(f"EndEvent_{step.num}",
                  end_x, ey_, EVENT_SIZE, EVENT_SIZE,
                  lane_id=step.lane_id,
                  label_text="終了", label_pos="below")

    # ── Edges (waypoint 付き) ──
    for f in flows:
        edge(f["id"], f["src"], f["tgt"])

    return ET.ElementTree(root)


def prettify_xml(tree):
    rough = ET.tostring(tree.getroot(), encoding="unicode")
    parsed = minidom.parseString(rough)
    return parsed.toprettyxml(indent="  ", encoding=None)


# ─────────────────────────────────────────────
# エントリポイント
# ─────────────────────────────────────────────

def parse_markdown(md_text):
    lines = md_text.splitlines()
    meta, remaining = parse_frontmatter(lines)
    sections = parse_sections(remaining)

    model = BpmnModel()
    model.process_id   = meta.get("process_id",   "process-1")
    model.process_name = meta.get("process_name", "業務プロセス")
    model.version      = meta.get("version",      "1.0")
    model.author       = meta.get("author",       "")
    model.purpose      = "\n".join(
        l for l in sections.get("目的", []) if l.strip()
    )
    model.lanes = parse_lanes(sections.get("レーン", []))
    model.steps = parse_flow(sections.get("フロー", []))
    return model


def convert_markdown(text: str) -> str:
    """
    Markdown テキストを受け取り BPMN XML 文字列を返す公開 API。
    Web UI / ライブラリ呼び出し用。
    バリデーションエラーがある場合は ValueError を送出する。
    警告 (W001, W002) はエラーとして扱わず、変換を続行する。
    """
    model = parse_markdown(text)
    errors, warnings = validate_model(model)
    if errors:
        raise ValueError("\n".join(errors))
    tree = build_bpmn_xml(model)
    return prettify_xml(tree)


def main():
    parser = argparse.ArgumentParser(
        description="Markdown から BPMN 2.0 XML (.bpmn) を生成します"
    )
    parser.add_argument("input",          help="入力 Markdown ファイルパス")
    parser.add_argument("-o", "--output", help="出力 .bpmn ファイルパス")
    parser.add_argument("--validate",     action="store_true",
                        help="バリデーションのみ（ファイルを生成しない）")
    parser.add_argument("--verbose",      action="store_true",
                        help="詳細ログを表示")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"[E001] 入力ファイルが見つかりません: {input_path}", file=sys.stderr)
        sys.exit(1)

    model = parse_markdown(input_path.read_text(encoding="utf-8"))

    if args.verbose:
        print(f"[INFO] process_id   : {model.process_id}")
        print(f"[INFO] process_name : {model.process_name}")
        print(f"[INFO] lanes        : {[l.id for l in model.lanes]}")
        print(f"[INFO] steps        : {len(model.steps)} ステップ")

    errors, warnings = validate_model(model)
    for w in warnings:
        print(f"[WARN] {w}")
    for e in errors:
        print(f"[ERROR] {e}", file=sys.stderr)

    if errors:
        print(f"\n{len(errors)} 件のエラーがあります。", file=sys.stderr)
        sys.exit(1)

    if args.validate:
        status = "✓ OK" if not errors else "✗ エラーあり"
        warn_s = f"（警告 {len(warnings)} 件）" if warnings else ""
        print(f"{status} {warn_s}")
        print(f"\n--- レーン ({len(model.lanes)}) ---")
        for lane in model.lanes:
            print(f"  {lane.id}: {lane.name}")
        print(f"\n--- ステップ ({len(model.steps)}) ---")
        for step in model.steps:
            suffix = ""
            if step.step_type == "gateway_ex":  suffix = f" <GW: {step.gateway_label}>"
            if step.step_type == "gateway_par": suffix = f" <GW||: {step.gateway_label}>"
            if step.is_end:                     suffix += " <END>"
            if step.explicit_next:              suffix += f" → {step.explicit_next}"
            print(f"  {step.num}. [{step.lane_id}] {step.label}{suffix}")
            for b in step.branches:
                flag = " (デフォルト)" if b.is_default else ""
                print(f"       - {b.condition}{flag} → {b.target}")
        return

    if args.output:
        output_path = Path(args.output)
    else:
        output_dir = input_path.parent.parent / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / (input_path.stem + ".bpmn")

    tree = build_bpmn_xml(model)
    output_path.write_text(prettify_xml(tree), encoding="utf-8")

    print(f"✓ 生成完了: {output_path}")
    if warnings:
        print(f"  （警告 {len(warnings)} 件）")
    print("  Camunda Modeler または https://demo.bpmn.io/ で開いて確認できます。")


if __name__ == "__main__":
    main()
