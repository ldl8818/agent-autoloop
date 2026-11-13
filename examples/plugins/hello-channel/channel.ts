// The smallest channel: every card becomes a few lines in a file. Someone answers with `agent-autoloop answer`, because a file
// has no buttons.
//   rules.json:  "channels": { "cards": { "name": "文件" } }
//   config.json: "channels": { "cards": { "use": "hello-channel", "key": "…", "file": "/绝对路径/cards.txt" } }
import { appendFileSync } from "node:fs";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  title: string;
  text: string;
  options: string[];
  rule?: string;
};
type Context = {
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(card: number, version: number, ref: string | null): Promise<unknown>;
    failed(card: number, version: number, error: string): Promise<unknown>;
  };
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

// Cards come from many rules: say which one, unless the title is already its name.
const words = ({ id, title, text, options, rule }: Card) =>
  [
    `#${id} ${title}`,
    ...(rule && rule !== title ? [`来源：${rule}`] : []),
    text,
    ...options.map((option, index) => `  ${index + 1}. ${option}`),
    "",
  ].join("\n");

export default async function helloChannel({ hub, options, log, signal }: Context) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card) continue;
    // A card with a ref has changed since it went out. A file can't change what it said, so there's only the report.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      appendFileSync(options.file as string, words(card));
      await hub.delivered(card.id, card.version, `file-${card.id}`);
    } catch (error) {
      log(`card ${card.id} not written: ${error}`);
      await hub.failed(card.id, card.version, String(error));
    }
  }
}
