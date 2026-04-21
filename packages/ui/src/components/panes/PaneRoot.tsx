import React from 'react';
import { cn } from '@/lib/utils';
import { PaneProvider } from '@/contexts/PaneContext';
import { useSessionUIStore, type PaneSide } from '@/sync/session-ui-store';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { PaneHeader } from './PaneHeader';

type Props = {
  pane: PaneSide;
  sessionId: string | null;
  isFocused: boolean;
  showHeader: boolean;
  showClose: boolean;
};

export const PaneRoot: React.FC<Props> = ({ pane, sessionId, isFocused, showHeader, showClose }) => {
  const setFocusedPane = useSessionUIStore((s) => s.setFocusedPane);

  // Focus follows explicit pointer gestures only. Focus events (onFocusCapture)
  // fire for programmatic focus() too — Radix restoring focus after a dropdown
  // closes, initial mount auto-focus, etc. — and those would flip the focused
  // pane back to whichever renders first in the DOM (left).
  const handlePointerInteraction = React.useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      if (event.button !== undefined && event.button !== 0 && event.button !== 2) return;
      if (!isFocused) setFocusedPane(pane);
    },
    [isFocused, pane, setFocusedPane],
  );

  return (
    <PaneProvider value={{ pane, sessionId, isFocused }}>
      <div
        onPointerDownCapture={handlePointerInteraction}
        className={cn(
          'relative flex h-full min-w-0 flex-1 flex-col overflow-hidden',
          !isFocused && 'opacity-[0.97]',
        )}
        data-pane={pane}
        data-pane-focused={isFocused ? 'true' : 'false'}
      >
        {showHeader ? (
          <PaneHeader
            pane={pane}
            sessionId={sessionId}
            isFocused={isFocused}
            showClose={showClose}
          />
        ) : null}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <ChatErrorBoundary sessionId={sessionId ?? undefined}>
            <ChatContainer />
          </ChatErrorBoundary>
        </div>
      </div>
    </PaneProvider>
  );
};
