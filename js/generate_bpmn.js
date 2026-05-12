// generate_bpmn.js -- Markdown -> BPMN 2.0 XML
// generate_bpmn.py (Python) の JavaScript 移植版。
// 公開 API: convertMarkdown(text: string) -> string

'use strict';

// ─── レイアウト定数 ────────────────────────────
const TASK_W       = 100;
const TASK_H       = 80;
const LANE_H       = 180;
const STEP_MARGIN  = 160;
const H_MARGIN     = 160;
const V_MARGIN     = 40;
const GW_SIZE      = 50;
const EVENT_SIZE   = 36;
const POOL_LABEL_W = 30;
const STEP_START   = 110;
const GW_LABEL_H   = 14;
const JP_CHAR_W    = 10;

// ─── ユーティリティ ───────────────────────────
function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── データコンストラクタ ──────────────────────
function makeLane(id, name, description = '') {
  return { id, name, description };
}

function makeBranch(condition, target) {
  const isDefault = ['(デフォルト)', '(default)'].includes(condition.trim());
  return { condition, target, isDefault };
}

function makeStep(num, laneId, label) {
  return {
    num, laneId, label,
    stepType:     'task',   // 'task' | 'gateway_ex' | 'gateway_par'
    gatewayLabel: '',
    branches:     [],
    explicitNext: null,
    isEnd:        false,
  };
}

function makeModel() {
  return {
    processId:   'process-1',
    processName: '業務プロセス',
    version:     '1.0',
    author:      '',
    purpose:     '',
    lanes:       [],
    steps:       [],
  };
}

// ─── パーサー ─────────────────────────────────

function parseFrontmatter(lines) {
  const meta = {};
  if (!lines.length || lines[0].trim() !== '---') return { meta, remaining: lines };
  let endIdx = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endIdx = i; break; }
  }
  if (endIdx === null) return { meta, remaining: lines };
  for (let i = 1; i < endIdx; i++) {
    const ci = lines[i].indexOf(':');
    if (ci !== -1) {
      meta[lines[i].slice(0, ci).trim()] = lines[i].slice(ci + 1).trim();
    }
  }
  return { meta, remaining: lines.slice(endIdx + 1) };
}

function parseSections(lines) {
  const sections = {};
  let key = null, cur = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (key) sections[key] = cur;
      key = m[1].trim(); cur = [];
    } else if (key) {
      cur.push(line);
    }
  }
  if (key) sections[key] = cur;
  return sections;
}

function parseLanes(laneLines) {
  const lanes = [];
  for (const line of laneLines) {
    const m = line.match(/\*\*(.+?)\*\*\s*\((\w+)\)(?::\s*(.*))?/);
    if (m) lanes.push(makeLane(m[2].trim(), m[1].trim(), (m[3] || '').trim()));
  }
  return lanes;
}

function parseFlow(flowLines) {
  const steps    = [];
  const reStep   = /^(\d+)\.\s+\[(\w+)\]\s+(.+)/;
  const reBranch = /^\s{2,}-\s+(.+?)\s*→\s*(\d+)/;
  const reGwEx   = /<GW:\s*(.+?)>/;
  const reGwPar  = /<GW\|\|:\s*(.+?)>/;
  const reEnd    = /<END>/;
  const reNext   = /→\s*(\d+)/;
  let cur = null;

  for (const line of flowLines) {
    if (/^\s*<!--/.test(line)) continue;

    const ms = line.match(reStep);
    if (ms) {
      const step = makeStep(parseInt(ms[1]), ms[2], ms[3].trim());

      const mgx = step.label.match(reGwEx);
      if (mgx) {
        step.stepType     = 'gateway_ex';
        step.gatewayLabel = mgx[1].trim();
        step.label        = step.label.replace(reGwEx, '').trim().replace(/→\s*$/, '').trim();
      }

      const mgp = step.label.match(reGwPar);
      if (mgp) {
        step.stepType     = 'gateway_par';
        step.gatewayLabel = mgp[1].trim();
        step.label        = step.label.replace(reGwPar, '').trim().replace(/→\s*$/, '').trim();
      }

      if (reEnd.test(step.label)) {
        step.isEnd = true;
        step.label = step.label.replace(reEnd, '').trim();
      }

      if (step.stepType === 'task' && !step.isEnd) {
        const mn = step.label.match(reNext);
        if (mn) {
          step.explicitNext = parseInt(mn[1]);
          step.label = step.label.replace(reNext, '').trim().replace(/→\s*$/, '').trim();
        }
      }

      cur = step;
      steps.push(step);
      continue;
    }

    const mb = line.match(reBranch);
    if (mb && cur) cur.branches.push(makeBranch(mb[1].trim(), parseInt(mb[2])));
  }
  return steps;
}

function parseMarkdown(text) {
  const lines = text.split('\n');
  const { meta, remaining } = parseFrontmatter(lines);
  const sections = parseSections(remaining);
  const model    = makeModel();
  model.processId   = meta['process_id']   || 'process-1';
  model.processName = meta['process_name'] || '業務プロセス';
  model.version     = meta['version']      || '1.0';
  model.author      = meta['author']       || '';
  model.purpose     = (sections['目的'] || []).filter(l => l.trim()).join('\n');
  model.lanes       = parseLanes(sections['レーン'] || []);
  model.steps       = parseFlow(sections['フロー']  || []);
  return model;
}

// ─── バリデーション ───────────────────────────

function validateModel(model) {
  const errors = [], warnings = [];
  const laneIds  = new Set(model.lanes.map(l => l.id));
  const stepNums = new Set(model.steps.map(s => s.num));

  if (!model.processId)   errors.push('E002: process_id が定義されていません');
  if (!model.lanes.length) errors.push('E003: レーンが1つも定義されていません');
  if (!model.steps.length) errors.push('E004: フローが1ステップも定義されていません');

  for (const s of model.steps) {
    if (!laneIds.has(s.laneId))
      errors.push(`E005: ステップ ${s.num} の lane_id '${s.laneId}' が未定義です`);
    if (s.explicitNext != null && !stepNums.has(s.explicitNext))
      errors.push(`E006: ステップ ${s.num} の → ${s.explicitNext} は存在しないステップ番号です`);
    if ((s.stepType === 'gateway_ex' || s.stepType === 'gateway_par') && !s.branches.length)
      warnings.push(`W001: ステップ ${s.num} のゲートウェイに分岐条件がありません`);
    for (const b of s.branches)
      if (!stepNums.has(b.target))
        errors.push(`E006: ステップ ${s.num} の分岐先 → ${b.target} は存在しないステップ番号です`);
  }
  return { errors, warnings };
}

// ─── フロー収集 ───────────────────────────────

function collectFlows(model) {
  const stepMap = Object.fromEntries(model.steps.map(s => [s.num, s]));
  const flows = [], seen = new Set();

  function add(id, src, tgt, condition = null, isDefault = false) {
    if (!seen.has(id)) { flows.push({ id, src, tgt, condition, isDefault }); seen.add(id); }
  }

  const lastStep = model.steps[model.steps.length - 1];

  if (model.steps.length) {
    const first = model.steps[0];
    add(`Flow_StartEvent_1_Task_${first.num}`, 'StartEvent_1', `Task_${first.num}`);
  }

  for (const step of model.steps) {
    const taskId = `Task_${step.num}`;

    if (step.stepType === 'gateway_ex' || step.stepType === 'gateway_par') {
      const gwId = `Gateway_${step.num}`;
      add(`Flow_${taskId}_${gwId}`, taskId, gwId);
      for (const b of step.branches) {
        const tId = `Task_${b.target}`;
        add(`Flow_${gwId}_${tId}`, gwId, tId, b.isDefault ? null : b.condition, b.isDefault);
      }
    } else if (step.isEnd) {
      const endId = `EndEvent_${step.num}`;
      add(`Flow_${taskId}_${endId}`, taskId, endId);
    } else if (step.explicitNext != null) {
      add(`Flow_${taskId}_Task_${step.explicitNext}`, taskId, `Task_${step.explicitNext}`);
    } else {
      const nextNum = step.num + 1;
      if (stepMap[nextNum]) {
        add(`Flow_${taskId}_Task_${nextNum}`, taskId, `Task_${nextNum}`);
      } else if (step === lastStep) {
        // 最後のステップで <END> なし → EndEvent へ接続
        add(`Flow_${taskId}_EndEvent_${step.num}`, taskId, `EndEvent_${step.num}`);
      }
    }
  }
  return flows;
}

// ─── XML ビルダー ─────────────────────────────

function buildBpmnXml(model) {
  const flows    = collectFlows(model);
  const lastStep = model.steps[model.steps.length - 1];
  const stepMap  = Object.fromEntries(model.steps.map(s => [s.num, s]));

  // incoming / outgoing インデックス
  const outgoing = {}, incoming = {};
  for (const f of flows) {
    (outgoing[f.src] = outgoing[f.src] || []).push(f.id);
    (incoming[f.tgt] = incoming[f.tgt] || []).push(f.id);
  }

  // レイアウト座標
  const stepX = {};
  let curX = H_MARGIN + POOL_LABEL_W + STEP_START;
  for (const step of model.steps) {
    stepX[step.num] = curX;
    curX += (step.stepType === 'gateway_ex' || step.stepType === 'gateway_par')
      ? STEP_MARGIN + 80
      : STEP_MARGIN;
  }
  const totalWidth  = curX + H_MARGIN;
  const totalHeight = V_MARGIN + model.lanes.length * LANE_H + V_MARGIN;

  const laneIndex  = Object.fromEntries(model.lanes.map((l, i) => [l.id, i]));
  const elemBounds = {};   // id -> [x, y, w, h]
  const elemLane   = {};   // id -> laneId

  function rec(id, x, y, w, h, laneId) {
    elemBounds[id] = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
    if (laneId != null) elemLane[id] = laneId;
  }

  // ─── XML 出力バッファ ───
  const X = [];

  X.push('<?xml version="1.0" encoding="UTF-8"?>');
  X.push('<bpmn:definitions');
  X.push('  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"');
  X.push('  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"');
  X.push('  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"');
  X.push('  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"');
  X.push(`  targetNamespace="http://bpmn.io/schema/bpmn"`);
  X.push(`  exporter="Markdown2BPMN JS" exporterVersion="1.0.0"`);
  X.push(`  id="Definitions_${model.processId}">`);

  const procId   = `Process_${model.processId}`;
  const collabId = 'Collaboration_1';
  const partId   = 'Participant_1';

  // Collaboration
  X.push(`  <bpmn:collaboration id="${collabId}">`);
  X.push(`    <bpmn:participant id="${partId}" name="${escXml(model.processName)}" processRef="${procId}"/>`);
  X.push(`  </bpmn:collaboration>`);

  // Process
  X.push(`  <bpmn:process id="${procId}" name="${escXml(model.processName)}" isExecutable="false">`);
  if (model.purpose) X.push(`    <bpmn:documentation>${escXml(model.purpose)}</bpmn:documentation>`);

  // LaneSet
  X.push(`    <bpmn:laneSet id="LaneSet_1">`);
  for (const lane of model.lanes) {
    X.push(`      <bpmn:lane id="Lane_${lane.id}" name="${escXml(lane.name)}">`);
    if (model.steps.length && model.steps[0].laneId === lane.id)
      X.push(`        <bpmn:flowNodeRef>StartEvent_1</bpmn:flowNodeRef>`);
    for (const step of model.steps) {
      if (step.laneId !== lane.id) continue;
      X.push(`        <bpmn:flowNodeRef>Task_${step.num}</bpmn:flowNodeRef>`);
      if (step.stepType === 'gateway_ex' || step.stepType === 'gateway_par')
        X.push(`        <bpmn:flowNodeRef>Gateway_${step.num}</bpmn:flowNodeRef>`);
      if (step.isEnd || (!step.explicitNext && step === lastStep))
        X.push(`        <bpmn:flowNodeRef>EndEvent_${step.num}</bpmn:flowNodeRef>`);
    }
    X.push(`      </bpmn:lane>`);
  }
  X.push(`    </bpmn:laneSet>`);

  // StartEvent
  const startId   = 'StartEvent_1';
  const firstLane = model.steps.length ? model.steps[0].laneId : model.lanes[0].id;
  elemLane[startId] = firstLane;
  X.push(`    <bpmn:startEvent id="${startId}" name="開始">`);
  for (const fid of (outgoing[startId] || [])) X.push(`      <bpmn:outgoing>${fid}</bpmn:outgoing>`);
  X.push(`    </bpmn:startEvent>`);

  // Steps
  for (const step of model.steps) {
    const taskId = `Task_${step.num}`;
    elemLane[taskId] = step.laneId;

    X.push(`    <bpmn:userTask id="${taskId}" name="${escXml(step.label)}">`);
    for (const fid of (incoming[taskId] || [])) X.push(`      <bpmn:incoming>${fid}</bpmn:incoming>`);
    for (const fid of (outgoing[taskId] || [])) X.push(`      <bpmn:outgoing>${fid}</bpmn:outgoing>`);
    X.push(`    </bpmn:userTask>`);

    if (step.stepType === 'gateway_ex' || step.stepType === 'gateway_par') {
      const gwId  = `Gateway_${step.num}`;
      const gwTag = step.stepType === 'gateway_ex' ? 'exclusiveGateway' : 'parallelGateway';
      const defB  = step.branches.find(b => b.isDefault);
      elemLane[gwId] = step.laneId;
      let gwA = `id="${gwId}" name="${escXml(step.gatewayLabel)}"`;
      if (defB && step.stepType === 'gateway_ex')
        gwA += ` default="Flow_${gwId}_Task_${defB.target}"`;
      X.push(`    <bpmn:${gwTag} ${gwA}>`);
      for (const fid of (incoming[gwId] || [])) X.push(`      <bpmn:incoming>${fid}</bpmn:incoming>`);
      for (const fid of (outgoing[gwId] || [])) X.push(`      <bpmn:outgoing>${fid}</bpmn:outgoing>`);
      X.push(`    </bpmn:${gwTag}>`);
    } else if (step.isEnd || (!step.explicitNext && step === lastStep)) {
      const endId = `EndEvent_${step.num}`;
      elemLane[endId] = step.laneId;
      X.push(`    <bpmn:endEvent id="${endId}" name="終了">`);
      for (const fid of (incoming[endId] || [])) X.push(`      <bpmn:incoming>${fid}</bpmn:incoming>`);
      X.push(`    </bpmn:endEvent>`);
    }
  }

  // SequenceFlows
  for (const f of flows) {
    if (f.condition) {
      X.push(`    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.src}" targetRef="${f.tgt}">`);
      X.push(`      <bpmn:conditionExpression>${escXml(f.condition)}</bpmn:conditionExpression>`);
      X.push(`    </bpmn:sequenceFlow>`);
    } else {
      X.push(`    <bpmn:sequenceFlow id="${f.id}" sourceRef="${f.src}" targetRef="${f.tgt}"/>`);
    }
  }
  X.push(`  </bpmn:process>`);

  // ─── BPMNDiagram ───
  X.push(`  <bpmndi:BPMNDiagram id="Diagram_1">`);
  X.push(`    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="${collabId}">`);

  // Shape ヘルパー
  function shape(id, x, y, w, h, laneId, extras, labelText, labelPos) {
    rec(id, x, y, w, h, laneId);
    const [rx, ry, rw, rh] = [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
    let s = `      <bpmndi:BPMNShape id="Shape_${id}" bpmnElement="${id}"`;
    if (extras) s += ` ${extras}`;
    s += `>\n        <dc:Bounds x="${rx}" y="${ry}" width="${rw}" height="${rh}"/>`;
    if (labelText != null && labelPos != null) {
      const lw = Math.max(labelText.length * JP_CHAR_W, 22);
      const lx = Math.round(x + (w - lw) / 2);
      const ly = labelPos === 'below' ? Math.round(y + h + 4) : Math.round(y - GW_LABEL_H - 6);
      s += `\n        <bpmndi:BPMNLabel>\n          <dc:Bounds x="${lx}" y="${ly}" width="${lw}" height="${GW_LABEL_H}"/>\n        </bpmndi:BPMNLabel>`;
    }
    s += `\n      </bpmndi:BPMNShape>`;
    X.push(s);
  }

  // Waypoint 計算
  function waypoints(srcId, tgtId) {
    if (!elemBounds[srcId] || !elemBounds[tgtId]) return [];
    const [sx, sy, sw, sh] = elemBounds[srcId];
    const [tx, ty, tw, th] = elemBounds[tgtId];
    const sCx = sx + sw / 2, sCy = sy + sh / 2;
    const tCx = tx + tw / 2, tCy = ty + th / 2;
    const sLi = laneIndex[elemLane[srcId]] ?? 0;
    const tLi = laneIndex[elemLane[tgtId]] ?? 0;
    if (sLi === tLi) return [[sx + sw, sCy], [tx, tCy]];
    if (sLi < tLi)  return [[sCx, sy + sh], [sCx, tCy], [tx, tCy]];
    const ix = tx - 30;
    if (ix > sx + sw) return [[sx + sw, sCy], [ix, sCy], [ix, tCy], [tx, tCy]];
    return [[sx + sw, sCy], [tCx, sCy], [tCx, ty + th]];
  }

  // Edge ヘルパー
  function edge(flowId, srcId, tgtId) {
    const wps = waypoints(srcId, tgtId);
    let e = `      <bpmndi:BPMNEdge id="Edge_${flowId}" bpmnElement="${flowId}">`;
    for (const [wx, wy] of wps)
      e += `\n        <di:waypoint x="${Math.round(wx)}" y="${Math.round(wy)}"/>`;
    e += `\n      </bpmndi:BPMNEdge>`;
    X.push(e);
  }

  // Pool
  shape(partId, H_MARGIN, V_MARGIN, totalWidth, totalHeight, null, 'isHorizontal="true"', null, null);

  // Lanes
  const laneX = H_MARGIN + POOL_LABEL_W;
  const laneW = totalWidth - H_MARGIN - POOL_LABEL_W;
  for (let i = 0; i < model.lanes.length; i++) {
    const ly = V_MARGIN + i * LANE_H;
    shape(`Lane_${model.lanes[i].id}`, laneX, ly, laneW, LANE_H, null, 'isHorizontal="true"', null, null);
  }

  // StartEvent
  if (model.steps.length) {
    const fs  = model.steps[0];
    const li  = laneIndex[fs.laneId] ?? 0;
    const seX = H_MARGIN + POOL_LABEL_W + 40;
    const seY = V_MARGIN + li * LANE_H + (LANE_H - EVENT_SIZE) / 2;
    shape(startId, seX, seY, EVENT_SIZE, EVENT_SIZE, fs.laneId, null, '開始', 'below');
  }

  // Tasks / Gateways / EndEvents
  for (const step of model.steps) {
    const li     = laneIndex[step.laneId] ?? 0;
    const x      = stepX[step.num];
    const taskY  = V_MARGIN + li * LANE_H + (LANE_H - TASK_H)    / 2;
    const eventY = V_MARGIN + li * LANE_H + (LANE_H - EVENT_SIZE) / 2;
    const gwY    = V_MARGIN + li * LANE_H + (LANE_H - GW_SIZE)    / 2;

    shape(`Task_${step.num}`, x, taskY, TASK_W, TASK_H, step.laneId, null, null, null);

    if (step.stepType === 'gateway_ex' || step.stepType === 'gateway_par') {
      const gwX = x + TASK_W + 60;
      shape(`Gateway_${step.num}`, gwX, gwY, GW_SIZE, GW_SIZE, step.laneId,
        'isMarkerVisible="true"', step.gatewayLabel, 'above');
    } else if (step.isEnd || (!step.explicitNext && step === lastStep)) {
      const endX = x + TASK_W + 40;
      shape(`EndEvent_${step.num}`, endX, eventY, EVENT_SIZE, EVENT_SIZE, step.laneId,
        null, '終了', 'below');
    }
  }

  // Edges
  for (const f of flows) edge(f.id, f.src, f.tgt);

  X.push(`    </bpmndi:BPMNPlane>`);
  X.push(`  </bpmndi:BPMNDiagram>`);
  X.push(`</bpmn:definitions>`);

  return X.join('\n');
}

// ─── 公開 API ─────────────────────────────────

function convertMarkdown(text) {
  const model = parseMarkdown(text);
  const { errors } = validateModel(model);
  if (errors.length) throw new Error(errors.join('\n'));
  return buildBpmnXml(model);
}
