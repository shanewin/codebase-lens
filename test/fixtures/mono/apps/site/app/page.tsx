import { Button } from '@acme/ui/button'
import { SelfImported } from '@acme/site/components/SelfImported'
import { Counter } from 'components/Counter'
import { ViaExtends } from '@site/components/ViaExtends'
import { stringify } from '@site/lib/toString'
export default function Home() { return <main><Button /><SelfImported /><Counter /><ViaExtends />{stringify(1)}</main> }
