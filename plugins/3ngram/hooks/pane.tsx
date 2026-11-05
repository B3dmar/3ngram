// SPDX-License-Identifier: Apache-2.0

import type { ElementTable, RenderElement } from 'claude-code'
import type { PanelState } from './lib/state.ts'
import { visibleDetail, visibleRows } from './lib/state.ts'
import type { Clock } from './lib/time.ts'
import type { DetailView, PanelView } from './lib/view.ts'
import { detailView, listNotice, panelView, sharesLine } from './lib/view.ts'

// The pane's drawing: the detail view and the list view of the state the
// render hook (register.tsx) hands it, laid out from the view model
// (lib/view.ts). It is synchronous, and has to stay so: the render hook reads
// its gate after its last await and passes what the gate let through, so a
// drawing that suspended could still be drawing it once a session.start had
// closed the gate. spec/render.spec.ts pins that this file never suspends.

// PaneActions are what the pane's buttons do. The render hook binds them to
// the reads, so this file starts nothing itself.
export type PaneActions = {
  back: () => void
  refresh: () => void
  cancel: () => void
  open: (memoryId: string) => void
}

// columns is the pane body's width (bodyColumns), which decides whether the
// status shares the header's line.
export function drawPane(
  ui: ElementTable,
  s: PanelState,
  clock: Clock,
  columns: number,
  act: PaneActions,
): RenderElement {
  const shownDetail = visibleDetail(s)
  if (shownDetail) {
    // The same gate as the detail: the row of the list it was opened from.
    const row = visibleRows(s)?.find((r) => r.memoryId === shownDetail.memoryId)
    return drawDetail(ui, detailView(shownDetail, clock, row), listNotice(s, clock), act)
  }
  return drawList(ui, panelView(s, clock), columns, act)
}

function drawDetail(
  ui: ElementTable,
  d: DetailView,
  notice: string | null,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = ui
  const lines = (prefix: string, items: string[], dim: boolean) =>
    items.map((line, i) => (
      <Text key={`${prefix}-${i}`} dimColor={dim}>
        {line}
      </Text>
    ))
  const section = (heading: string, body: RenderElement[]) =>
    body.length > 0 ? (
      <Box key={`section-${heading}`} flexDirection="column" marginTop={1}>
        <Text bold>{heading}</Text>
        {body}
      </Box>
    ) : null
  return (
    <Box flexDirection="column">
      <Box>
        <Button key="back" label="Back" hotkey="b" onPress={act.back} />
      </Box>
      {notice !== null ? <Text bold>{notice}</Text> : null}
      <Text bold>{d.title}</Text>
      {d.labels.length > 0 ? <Text dimColor>{d.labels.join(' · ')}</Text> : null}
      <Text bold={d.status.tone === 'error'} dimColor={d.status.tone === 'busy'}>
        {d.status.label}
      </Text>
      {d.hint !== null ? <Text dimColor>{d.hint}</Text> : null}
      {d.content !== null ? (
        <Box marginTop={1}>
          <Text>{d.content}</Text>
        </Box>
      ) : null}
      {section('Source', lines('source', d.source, true))}
      {section('Evidence', [
        ...lines('evidence', d.evidence, false),
        ...lines('window', d.window, true),
      ])}
      {section('History', lines('history', d.history, true))}
      {d.notes.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {lines('note', d.notes, true)}
        </Box>
      ) : null}
    </Box>
  )
}

function drawList(
  ui: ElementTable,
  view: PanelView,
  columns: number,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = ui
  const inline = sharesLine(view.header, view.status.label, columns)
  return (
    <Box flexDirection="column">
      {/* The status keeps every word where it does not fit beside the
          header: it takes a line of its own and wraps there. */}
      <Box key="header" flexDirection={inline ? 'row' : 'column'} justifyContent="space-between">
        <Text bold>{view.header}</Text>
        <Text
          bold={view.status.tone === 'stale' || view.status.tone === 'error'}
          dimColor={view.status.tone === 'busy'}
        >
          {view.status.label}
        </Text>
      </Box>
      {view.hint !== null ? <Text dimColor>{view.hint}</Text> : null}
      <Box>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={act.refresh} />
        {view.canCancel ? (
          <Button key="cancel" label="Cancel" hotkey="c" onPress={act.cancel} />
        ) : null}
      </Box>
      {view.empty !== null ? <Text dimColor>{view.empty}</Text> : null}
      {view.sections.map((section, si) => (
        <Box key={`section-${si}`} flexDirection="column" marginTop={1}>
          <Text bold>{section.title}</Text>
          {/* Keyed by memory id: the surface finds a Button again by its
              key after a redraw, so a key naming a position would move the
              focus to whichever row a refresh puts there. */}
          {section.rows.map((row) => (
            <Box key={`row-${row.memoryId}`} flexDirection="column" paddingLeft={2}>
              <Button key={`open-${row.memoryId}`} plain onPress={() => act.open(row.memoryId)}>
                {/* One row per title, cut at the pane's edge by the surface,
                    which measures wide characters; the detail shows it whole.
                    The labels below wrap: they carry the row's state. */}
                <Text wrap="truncate-end">{row.title}</Text>
              </Button>
              <Text dimColor>{row.labels.join(' · ')}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {view.notes.length > 0 || view.footer !== null ? (
        <Box flexDirection="column" marginTop={1}>
          {view.notes.map((note, i) => (
            <Text key={`note-${i}`} dimColor>
              {note}
            </Text>
          ))}
          {view.footer !== null ? <Text dimColor>{view.footer}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}
