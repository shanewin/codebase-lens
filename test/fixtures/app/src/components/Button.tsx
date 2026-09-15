export function Button(props: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={props.onClick}>{props.children}</button>
}
export function IconButton() { return <button /> }
