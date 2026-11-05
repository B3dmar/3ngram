// SPDX-License-Identifier: Apache-2.0

import type { ElementTable, RenderElement } from 'claude-code'
import type { SessionRow, SessionView } from './lib/session-view.ts'

// Like pane.tsx, this drawing must stay synchronous after the render gate.
export function drawSession(ui: ElementTable, view: SessionView): RenderElement {
  const { Box, Text } = ui
  const rows = (items: SessionRow[], empty: string) =>
    items.length === 0 ? (
      <Text dimColor>{empty}</Text>
    ) : (
      items.map((row) => (
        <Box key={row.key} flexDirection="column" paddingLeft={2}>
          <Text wrap="truncate-end">{row.title}</Text>
          <Text dimColor>{row.labels}</Text>
        </Box>
      ))
    )
  return (
    <Box flexDirection="column">
      <Text bold>Session activity</Text>
      {view.servers.length === 0 ? (
        <Text dimColor>No 3ngram MCP calls observed this session.</Text>
      ) : null}
      {view.servers.map((server, i) => (
        <Box key={`server-${i}`} flexDirection="column" marginTop={1}>
          <Text bold>{server.name}</Text>
          <Text>{server.counts}</Text>
          {server.notes.map((note, n) => (
            <Text key={`note-${n}`} dimColor>
              {note}
            </Text>
          ))}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Recent writes</Text>
            {rows(server.writes, 'No successful memory writes observed.')}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Most read</Text>
            {rows(server.reads, 'No memory reads observed.')}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Latest observed MCP briefing</Text>
            {server.briefing.map((line, n) => (
              <Text key={`briefing-${n}`} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {view.notes.map((note, i) => (
          <Text key={`scope-${i}`} dimColor>
            {note}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
