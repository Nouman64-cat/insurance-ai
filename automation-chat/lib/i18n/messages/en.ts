// English UI text. This file defines the keys: ur.ts must translate every one of them (the compiler checks).
const en = {
  common: {
    language: "Language",
    cancel: "Cancel",
    image: "Image",
    document: "Document",
  },
  sso: {
    signingIn: "Signing you in from the portal…",
    unreachable: "The sign-in service could not be reached. Retrying…",
    notResponding: "The sign-in service is not responding. Retrying…",
  },
  sidebar: {
    newChat: "New chat",
    search: "Search chats…",
    chatTools: "Chat tools",
    selectChats: "Select chats",
    selectAll: "Select all ({count})",
    deleteSelected: "Delete ({count})",
    noMatch: "No chats match “{query}”",
    selectChat: "Select {title}",
    untitled: "chat",
    generatingTitle: "Generating title…",
    pinned: "Pinned",
    chatOptions: "Chat options",
    pin: "Pin chat",
    unpin: "Unpin chat",
    rename: "Rename",
    exportMarkdown: "Export as Markdown",
    exportJson: "Export as JSON",
    deleteChat: "Delete chat",
    seeMore: "See more",
    backToDashboard: "Back to Dashboard",
  },
  header: {
    showHistory: "Show chat history",
    hideHistory: "Hide chat history",
    beta: "Beta",
    journeyMap: "Journey map",
    backToChat: "Back to chat",
    journey: "Journey",
    chat: "Chat",
    clear: "Clear",
    clearChat: "Clear chat",
  },
  composer: {
    welcome: "How can I help you today?",
    askAnything: "Ask anything...",
    message: "Message…",
    typeAnswer: "Type your answer…",
    attach: "Attach",
    attachDocument: "Attach Document",
    voiceAgent: "Live Voice Agent",
    holdToDictate: "Hold to dictate",
  },
  messageActions: {
    copy: "Copy",
    share: "Share",
    download: "Download",
    regenerate: "Regenerate from here — drops everything after this reply",
    helpful: "Helpful",
    unhelpful: "Unhelpful",
    more: "More",
  },
};

type Dict<T> = { [K in keyof T]: T[K] extends string ? string : Dict<T[K]> };
export type Messages = Dict<typeof en>;

export default en;
