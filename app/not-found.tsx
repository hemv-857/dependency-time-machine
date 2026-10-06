import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-16">
      <div className="card mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-bold text-slate-100">That&apos;s not a time machine URL</h1>
        <p className="mt-3 text-slate-400">Snapshot links look like this:</p>
        <ul className="mono mt-3 space-y-1 text-slate-300">
          <li>/github.com/facebook/create-react-app@2022-06-01</li>
          <li>/github.com/expressjs/express@2019-01-01</li>
          <li>
            /github.com/expressjs/express@v4.17.1{' '}
            <span className="text-slate-500">← tags work too</span>
          </li>
        </ul>
        <p className="mt-4 text-sm text-slate-400">
          Dates default to one year ago. Try the <Link className="link" href="/">launcher</Link> instead.
        </p>
      </div>
    </div>
  );
}