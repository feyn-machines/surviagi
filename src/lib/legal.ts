import type { Language } from "./i18n";

export type Doc = {
  title: string;
  updated: string;
  sections: { heading: string; body: string[] }[];
};

/**
 * The privacy and terms pages, one document per language. `{x}` and `{discord}`
 * in a paragraph become the project's own links. This is a plain Record rather
 * than `bilingual()`, whose values are limited to strings; both languages are
 * still required by the type.
 */
export const legalCopy: Record<Language, { privacy: Doc; terms: Doc }> = {
  en: {
    privacy: {
      title: "Privacy",
      updated: "2026-10-26",
      sections: [
        {
          heading: "What we store",
          body: [
            "When you sign in with Google: your email address, name and profile picture, as Google gives them to us. Signing in also records your IP address and browser type with the session, and Google's sign-in tokens, which we do not use for anything else.",
            "When you submit an account: the X handle, whether it is a person or a company, and your note.",
            "When you subscribe: which topics, your language, and when.",
            "When you make an API key: its name, its first characters, when it was made, last used and revoked. Only a hash of the key itself is kept.",
            "When you or your agent submits a research question: the question, why it matters, what is missing, your leads, the records you name, and which key sent it. A question stays private and is never published as written.",
            "Searching and reading through the agent interface needs no account; it records nothing about you beyond the short-lived counts that limit request rates.",
          ],
        },
        {
          heading: "What we use it for",
          body: [
            "To show you your own submissions and their status, to let an administrator review them, to enforce the submission limits, and to send the updates you subscribed to. Nothing else.",
          ],
        },
        {
          heading: "What we do not do",
          body: [
            "We do not sell or share your information. We do not use it for advertising.",
            "Reading the site needs no account and sets no tracking cookie; signing in sets a session cookie, and choosing a language saves that choice.",
          ],
        },
        {
          heading: "Where it is kept",
          body: ["On our server, in a database separate from the published data. Backups are kept for 14 days."],
        },
        {
          heading: "Your choices",
          body: [
            "Unsubscribe at any time from the Subscribe control. Revoke an API key at any time on the agents page.",
            "To have your account and everything tied to it deleted, contact us on X at {x} or in our {discord}; we delete it within 30 days.",
          ],
        },
        {
          heading: "Changes",
          body: ["We change this page when what we store changes, and date it."],
        },
      ],
    },
    terms: {
      title: "Terms",
      updated: "2026-10-26",
      sections: [
        {
          heading: "What this is",
          body: [
            "SurviAGI is an initiative to make progress toward AI independently completing major work more transparent. The site is provided as is, without warranty.",
          ],
        },
        {
          heading: "The data",
          body: [
            "Levels, links and readings on this site are proposed by machine and have not been reviewed. Check the original source before relying on any of it.",
          ],
        },
        {
          heading: "Submitting accounts",
          body: [
            "Submit only public X accounts that publish about AI. Do not submit accounts to harass someone or to impersonate them.",
            "A submission is a request: we may decline it, and approval does not mean the account's identity has been confirmed.",
            "The same holds for research questions and for anything an agent submits with your API key: you are responsible for what is sent with your key. Keep it secret, and revoke it if it leaks.",
          ],
        },
        {
          heading: "Your account",
          body: ["You sign in with Google. We may remove submissions or close accounts that abuse the site."],
        },
        {
          heading: "Contact",
          body: ["X {x}, or our {discord}."],
        },
      ],
    },
  },
  "zh-CN": {
    privacy: {
      title: "隐私",
      updated: "2026-10-26",
      sections: [
        {
          heading: "存储什么",
          body: [
            "使用 Google 登录时：你的邮箱地址、姓名和头像，均为 Google 提供给我们的内容。登录时还会随会话记录你的 IP 地址和浏览器类型，以及 Google 的登录令牌，不作他用。",
            "提交帐号时：该 X 帐号的用户名、它属于个人还是公司，以及你写的备注。",
            "订阅时：订阅的主题、你的语言和订阅时间。",
            "生成 API Key 时：Key 的名称、开头几个字符，以及创建、最近使用和撤销的时间。Key 本身只保存其哈希值。",
            "你或你的助手提交研究问题时：问题本身、研究意义、资料缺口、你提供的线索和记录，以及提交所用的 Key。问题保持私有，不会按原文公开。",
            "通过助手接口搜索和读取无需帐号，除用于限制请求频率的短时计数外，不记录与你有关的任何信息。",
          ],
        },
        {
          heading: "用来做什么",
          body: ["用于向你展示你自己的提交及其状态，供管理员审核，执行提交额度，并发送你订阅的更新。除此之外不作他用。"],
        },
        {
          heading: "不做什么",
          body: [
            "我们不出售或共享你的信息，也不将其用于广告。",
            "浏览本站无需帐号，也不设置追踪 Cookie；登录会设置会话 Cookie，选择语言会保存该选择。",
          ],
        },
        {
          heading: "保存在哪",
          body: ["保存在我们的服务器上，数据库与已发布的数据分开。备份保留 14 天。"],
        },
        {
          heading: "你的选择",
          body: [
            "可随时通过“订阅”控件取消订阅，也可随时在“接入 AI 助手”页面撤销 API Key。",
            "如需删除你的帐号及与之相关的全部内容，请在 X 上联系 {x}，或通过我们的 {discord} 联系我们；我们会在 30 天内删除。",
          ],
        },
        {
          heading: "变更",
          body: ["所存储的内容发生变化时，我们会修改本页并标注日期。"],
        },
      ],
    },
    terms: {
      title: "条款",
      updated: "2026-10-26",
      sections: [
        {
          heading: "这是什么",
          body: ["SurviAGI 是一项倡议，让 AI 独立完成主要工作的进展变得更透明。本站按现状提供，不作任何担保。"],
        },
        {
          heading: "关于数据",
          body: ["本站的等级、链接和读数均由机器提出、未经审核。依赖其中任何内容之前，请先核对原始来源。"],
        },
        {
          heading: "提交帐号",
          body: [
            "只提交公开的、发布 AI 相关内容的 X 帐号。不要为骚扰或冒充他人而提交帐号。",
            "提交只是一项请求：我们可能拒绝；通过也不代表该帐号的身份已得到确认。",
            "研究问题，以及助手用你的 API Key 提交的任何内容，同样如此：用你的 Key 发出的内容由你负责。请妥善保管，泄露后请立即撤销。",
          ],
        },
        {
          heading: "你的帐号",
          body: ["你通过 Google 登录。对滥用本站的提交或帐号，我们可能予以删除或关闭。"],
        },
        {
          heading: "联系方式",
          body: ["X {x}，或我们的 {discord}。"],
        },
      ],
    },
  },
};
