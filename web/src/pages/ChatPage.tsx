import { useState } from 'react';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ChatHeader } from '../components/chat/ChatHeader';
import { Composer } from '../components/chat/Composer';
import { GroupMembersPanel } from '../components/chat/GroupMembersPanel';
import { MessageThread } from '../components/chat/MessageThread';
import { NewChatModal } from '../components/chat/NewChatModal';
import { Sidebar } from '../components/chat/Sidebar';
import { CallHistoryPanel } from '../components/calls/CallHistoryPanel';
import { CallOverlay } from '../components/calls/CallOverlay';
import { IncomingCallModal } from '../components/calls/IncomingCallModal';
import { directPeer } from '../lib/format';
import type { CallKind, UUID } from '../lib/types';
import { useAuthStore } from '../store/auth';
import { useCallStore } from '../store/call';
import { useChatStore } from '../store/chat';
import { toast } from '../store/toast';

export function ChatPage() {
  const myUserId = useAuthStore((state) => state.user?.id ?? null);
  const conversations = useChatStore((state) => state.conversations);
  const activeConversationId = useChatStore((state) => state.activeConversationId);
  const setActiveConversation = useChatStore((state) => state.setActiveConversation);
  const startCall = useCallStore((state) => state.startCall);

  const [newChatOpen, setNewChatOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  if (!myUserId) return null;

  const activeView = conversations.find((view) => view.conversation.id === activeConversationId) ?? null;

  const handleCall = (kind: CallKind, peerId?: UUID): void => {
    if (!activeView) return;
    const peer = peerId
      ? activeView.members.find((member) => member.id === peerId) ?? null
      : directPeer(activeView, myUserId);
    if (!peer) {
      toast.error('Не удалось определить собеседника');
      return;
    }
    // Звонки в контракте 1:1, поэтому для группы conversation_id не передаём —
    // backend сам найдёт/создаст direct-диалог с выбранным участником.
    const conversationId =
      activeView.conversation.kind === 'direct' ? activeView.conversation.id : undefined;
    void startCall(peer, kind, conversationId);
  };

  return (
    <div className="app">
      <ConnectionBanner />

      <div className="chat-shell" data-conversation-open={activeView ? 'true' : 'false'}>
        <Sidebar
          myUserId={myUserId}
          onSelectConversation={(conversationId) => {
            setActiveConversation(conversationId);
            setMembersOpen(false);
          }}
          onOpenCallHistory={() => setHistoryOpen(true)}
          onOpenNewChat={() => setNewChatOpen(true)}
        />

        <main className="chat-main">
          {activeView ? (
            <>
              <ChatHeader
                view={activeView}
                myUserId={myUserId}
                onBack={() => setActiveConversation(null)}
                onToggleMembers={() => setMembersOpen((open) => !open)}
                onCall={(kind) => handleCall(kind)}
              />
              <MessageThread
                conversationId={activeView.conversation.id}
                members={activeView.members}
                myUserId={myUserId}
              />
              <Composer conversationId={activeView.conversation.id} />
            </>
          ) : (
            <div className="chat-main__empty">
              <h2>Выберите диалог</h2>
              <p className="muted">Или найдите собеседника в поиске слева</p>
            </div>
          )}
        </main>
      </div>

      <NewChatModal open={newChatOpen} onClose={() => setNewChatOpen(false)} />
      <CallHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />

      {activeView && membersOpen ? (
        <GroupMembersPanel
          view={activeView}
          myUserId={myUserId}
          onClose={() => setMembersOpen(false)}
          onCall={(peerId, kind) => {
            setMembersOpen(false);
            handleCall(kind, peerId);
          }}
        />
      ) : null}

      <IncomingCallModal />
      <CallOverlay />
    </div>
  );
}
