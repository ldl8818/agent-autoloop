// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connection that brings
// clicks back, so this machine needs no public address. Only one listener can hold an app's card clicks, so run this in
// one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import { execFile, spawn } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { eachLine } from "../../host/lines.ts";
import { commandLine } from "../../host/command.ts";

/** Feishu sends these values as JSON in a string, which may be empty. */
function safeJson(text: unknown): any {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `你选了「${chosen}」，已记录，等待处理。`;
  if (card.state === "done") return `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** Labels are display-only; the rule and card number still determine where an answer goes. */
function projectName(card: Card, projects: Record<string, string>) {
  // /tell without a rule uses the configured source/task name as its title.
  const origin = card.rule ?? card.title;
  const match = Object.entries(projects)
    .filter(([prefix, name]) => prefix && typeof name === "string" && name.trim() && origin.startsWith(prefix))
    .sort(([a], [b]) => b.length - a.length)[0];
  return match?.[1].trim() || card.rule || "中台";
}

function contentOf(card: Card, settled: boolean, title: string) {
  if (!card.text && title === card.title) return [];
  const marker = "\n\n## 详情\n";
  const at = card.text.indexOf(marker);
  const lead = at < 0 ? card.text : card.text.slice(0, at);
  const long = lead.length > 200;
  const preview = long ? Array.from(lead.split("\n")[0]).slice(0, 180).join("") : lead;
  const original = settled || long ? card.text : at < 0 ? "" : card.text.slice(at + marker.length);
  const details = (title !== card.title ? `${card.title}\n\n` : "") + original;
  return [
    ...(!settled && preview
      ? [long ? { tag: "div", text: { tag: "plain_text", content: preview } } : { tag: "markdown", content: preview }]
      : []),
    ...(details
      ? [
          {
            tag: "collapsible_panel",
            expanded: false,
            header: { title: { tag: "plain_text", content: settled ? "查看原始内容" : "查看详情" } },
            elements: [{ tag: "markdown", content: details }],
          },
        ]
      : []),
  ];
}

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card, projects: Record<string, string> = {}) {
  const outcome = outcomeOf(card);
  const title = Array.from(card.title.replace(/^主人[，,：:]\s*/u, "").split("\n")[0])
    .slice(0, 36)
    .join("");
  const status =
    card.state === "open"
      ? card.kind === "ask"
        ? "等待决定"
        : "待处理"
      : card.state === "decided"
        ? "等待处理"
        : card.state === "done"
          ? "已执行"
          : card.kind === "ask"
            ? "已结束"
            : card.result
              ? "已结案"
              : "进度通知";
  // Each option is a block across the card, its words wrapping: buttons in a row, one line high, cut long options off.
  const option = (label: string, index: number) => ({
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: index === card.recommend ? "blue" : "grey",
    corner_radius: "8px",
    padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  const afterwards = outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : [];
  const noteSaid =
    card.kind === "notice" && card.answer
      ? [{ tag: "div", text: { tag: "plain_text", content: `处理说明：${card.answer}` } }]
      : [];
  const notice = card.kind === "notice";
  const input = {
    tag: "input",
    input_type: "multiline_text",
    auto_resize: true,
    max_length: 1000,
  };
  const submit = { tag: "button", form_action_type: "submit", type: "primary" };
  const textForm = notice
    ? {
        tag: "form",
        name: "handling_note",
        elements: [
          {
            ...input,
            name: "note",
            rows: 2,
            label: { tag: "plain_text", content: "处理说明（可不填）" },
            label_position: "top",
            placeholder: { tag: "plain_text", content: "比如：已回复他视频下周发；或：群发广告，不用管" },
          },
          {
            ...submit,
            name: `handling_note_submit_${card.id}`,
            text: { tag: "plain_text", content: "记录并结案" },
          },
        ],
      }
    : {
        tag: "form",
        name: `custom_answer_${card.id}`,
        // Forms cannot be nested inside panels; put the panel inside a root-level form.
        elements: [
          {
            tag: "collapsible_panel",
            expanded: false,
            header: { title: { tag: "plain_text", content: "其他方案：我来说明" } },
            elements: [
              {
                ...input,
                name: "answer",
                rows: 3,
                required: true,
                placeholder: { tag: "plain_text", content: "写下您的方案，也可用输入法语音转文字，检查后提交" },
              },
              {
                ...submit,
                name: `custom_answer_submit_${card.id}`,
                text: { tag: "plain_text", content: "按我的说明继续" },
              },
            ],
          },
        ],
      };
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: `${projectName(card, projects)}｜${title}｜${status}` },
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...afterwards,
        ...noteSaid,
        ...contentOf(card, !!outcome, title),
        ...(card.state === "open"
          ? [...(notice ? [textForm] : []), ...card.options.map(option), ...(notice ? [] : [textForm])]
          : []),
        { tag: "div", text: { tag: "plain_text", content: `卡片 #${card.id}` } },
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const lark = async (args: string[], input: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        ...commandLine([program, ...args]),
        { encoding: "utf8", timeout: 60_000, signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  /** Sends the card's words as a new message, or hands back the one an earlier try with this key already made. */
  async function sendMessage(key: string, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    const once = ["--idempotency-key", key];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", "-"], content)).data
      .message_id as string;
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const projects = options.projects;
        const content = JSON.stringify(
          render(
            card,
            projects && typeof projects === "object" && !Array.isArray(projects)
              ? (projects as Record<string, string>)
              : {},
          ),
        );
        let ref = card.ref;
        if (ref) {
          try {
            await updateMessage(ref, content);
          } catch (error) {
            // The bot may not be the sender of the message it is told to change, and Feishu refuses that outright. An open
            // card stays as it is: the hub only counts answers on the message it first heard of, whose buttons still work.
            if (card.state === "open") throw error;
            // A settled one has no buttons: a second card is worse than one, a card frozen at the version before the answer
            // is worse than both. The key has the version so that a retry of this one makes no third.
            log(`card ${card.id}: couldn't update ${ref} (${error}); sending it again`);
            await sendMessage(`agent-autoloop-card-${card.id}-v${card.version}`, content);
          }
          // The key is the card alone, not its version: a report that got lost must not make a second message.
        } else ref = await sendMessage(`agent-autoloop-card-${card.id}`, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the card that was sent counts; the hub checks both. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const form = safeJson(event.form_value);
    const value = safeJson(event.action_value);
    // A form's submit button can't carry a value, so its name holds the card's number.
    const action = String(event.action_name ?? "");
    const textButton = /^(custom_answer|ask_text)_submit_(\d+)$/.exec(action);
    const noteButton = /^handling_note_submit_(\d+)$/.exec(action);
    const cardId = textButton
      ? Number(textButton[2])
      : Number.isInteger(value?.card)
        ? value.card
        : Number(noteButton?.[1]);
    if (!Number.isInteger(cardId)) return;
    const given: { choice?: number; by?: string; ref?: string; text?: string } = {
      by: event.operator_id,
      ref: event.message_id,
    };
    if (textButton) {
      const text = textButton[1] === "custom_answer" ? form?.answer : form?.note;
      if (typeof text !== "string" || !text.trim() || text.length > 1000) return;
      given.text = text;
    } else {
      // A notice's only option is that it's been handled, so submitting its form picks it.
      const choice = Number.isInteger(value?.choice) ? value.choice : form ? 0 : null;
      if (choice === null) return;
      given.choice = choice;
      if (typeof form?.note === "string") given.text = form.note;
    }
    const answer = await hub.answer(cardId, given);
    const how = textButton ? "text submitted" : form ? "note submitted" : "answered";
    log(`card ${cardId}: ${how} by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      const consume = spawn(...commandLine([program, "event", "consume", "card.action.trigger", "--as", "bot"]), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Unheard, this would end the whole hub. A process that never started still closes, which starts it again below.
      consume.on("error", (error) => log(`the click listener couldn't run: ${error}`));
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      eachLine(consume.stderr, log);
      eachLine(consume.stdout, (line) => void clicked(line).catch((error) => log(`click not handled: ${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
