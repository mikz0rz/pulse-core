// TwitterClient's Puppeteer-backed operations (getListTweets, postTweet,
// likeTweet, etc.) all share one browser page with no internal locking.
// Any code path that touches those must go through this shared mutex so a
// scheduled fetch and a manual "refresh now" request can never race.
class Mutex {
  private tail: Promise<any> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export const browserMutex = new Mutex();
