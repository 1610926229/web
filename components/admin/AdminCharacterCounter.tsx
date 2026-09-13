/**
 * 字数计数器（`当前/上限`，超出时变红并写明超了几个字）。
 *
 * 存在的理由与用户端的做法一致：**输入框不用 `maxLength` 静默截断**。
 * 截断会让人以为「我已经写完了」，而真相是后面那半句根本没进去。
 * 因此字数必须实时可见，超限要有明确说法。
 *
 * ⚠️ 计数用 `countCharacters()`（按用户眼里的字符算，Emoji 记 1），
 * 与服务端校验、测试**同一个函数**——否则就会出现「框里显示没超、提交却被拒绝」。
 */
export default function AdminCharacterCounter({
  current,
  max,
}: {
  current: number;
  max: number;
}) {
  const tooLong = current > max;
  return (
    <span className={`shrink-0 text-[12px] ${tooLong ? "text-brand-red" : "text-ink-3"}`}>
      {current}/{max}
      {tooLong ? `（超出 ${current - max} 字）` : ""}
    </span>
  );
}
