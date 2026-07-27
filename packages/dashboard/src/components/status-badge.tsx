import { Badge } from '@/components/ui/badge'

export function StatusBadge({ status }: { status: number | null | undefined }) {
  if (status === null || status === undefined) {
    return <Badge variant="outline">pending</Badge>
  }

  const variant =
    status >= 500 ? 'destructive' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success'

  return <Badge variant={variant}>{status}</Badge>
}
