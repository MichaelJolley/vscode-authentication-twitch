import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';

function sendFile(res: http.ServerResponse, filepath: string) {
  fs.readFile(filepath, (err, body) => {
    if (err) {
      console.error(err);
      res.writeHead(404);
      res.end();
    } else {
      // Big thanks to @wwsean08 for this fix to get css files to load and render
      // the html with styles properly!
      res.writeHead(200, {
        contentType: "",
        "Content-Type": filepath.endsWith('.css') ? "text/css" : "text/html",
        "Cache-Control": "no-cache",
        'content-length': body.length,
      });
      res.end(body);
    }
  });
}

interface IOAuthResult {
  accessToken: string;
  state: string;
}

interface ILoopbackServer {
  /**
   * If undefined, the server is not started yet.
   */
  port: number | undefined;

  /**
   * The nonce used
   */
  nonce: string;

  /**
   * The state parameter used in the OAuth flow.
   */
  state: string | undefined;

  /**
   * Starts the server.
   * @returns The port to listen on.
   * @throws If the server fails to start.
   * @throws If the server is already started.
   */
  start(): Promise<number>;
  /**
   * Stops the server.
   * @throws If the server is not started.
   * @throws If the server fails to stop.
   */
  stop(): Promise<void>;
  /**
   * Returns a promise that resolves to the result of the OAuth flow.
   */
  waitForOAuthResponse(): Promise<IOAuthResult>;
}

export class LoopbackAuthServer implements ILoopbackServer {
  private readonly _server: http.Server;
  private readonly _resultPromise: Promise<IOAuthResult>;
  private _startingRedirect: URL;
  private openSockets: net.Socket[] = [];

  public nonce = randomBytes(16).toString('base64');
  public port: number | undefined;

  public set state(state: string | undefined) {
    if (state) {
      this._startingRedirect.searchParams.set('state', state);
    } else {
      this._startingRedirect.searchParams.delete('state');
    }
  }
  public get state(): string | undefined {
    return this._startingRedirect.searchParams.get('state') ?? undefined;
  }

  constructor(serveRoot: string, startingRedirect: string) {
    if (!serveRoot) {
      throw new Error('serveRoot must be defined');
    }
    if (!startingRedirect) {
      throw new Error('startingRedirect must be defined');
    }
    this._startingRedirect = new URL(startingRedirect);
    let deferred: { resolve: (result: IOAuthResult) => void; reject: (reason: any) => void };
    this._resultPromise = new Promise<IOAuthResult>((resolve, reject) => deferred = { resolve, reject });

    this._server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url!, `http://${req.headers.host}`);
      switch (reqUrl.pathname) {
        case '/signin': {
          const receivedNonce = (reqUrl.searchParams.get('nonce') ?? '').replace(/ /g, '+');

          if (receivedNonce !== this.nonce) {
            deferred.reject(new Error('Nonce does not match.'));
            res.writeHead(302, { location: `/?error=${encodeURIComponent('Nonce does not match.')}` });
            res.end();
          }
          res.writeHead(302, { location: this._startingRedirect.toString() });
          res.end();
          break;
        }
        case '/oauth': {
          const accessToken = reqUrl.searchParams.get('access_token');
          const state = reqUrl.searchParams.get('state');
          if (!accessToken || !state) {
            deferred.reject(new Error('Missing data that\'s required.'));
            res.writeHead(302, { location: `/?error=${encodeURIComponent('Missing data that\'s required.')}` });
            res.end();
            return;
          }
          if (this.state !== state) {
            deferred.reject(new Error('State does not match.'));
            res.writeHead(302, { location: `/?error=${encodeURIComponent('State does not match.')}` });
            res.end();
            throw new Error('State does not match.');
          }

          deferred.resolve({ accessToken, state });
          res.writeHead(302, { location: '/complete' });
          res.end();
          return;
        }
        case '/complete': {
          sendFile(res, path.join(serveRoot, 'index.html'))
          break;
        }
        case '/index.css': {
          sendFile(res, path.join(serveRoot, 'index.css'));
          break;
        }
        case "/favicon.ico": {
          res.writeHead(204);
          res.end();
          break;
        }
        // Serve the static files
        case '/': {
          sendFile(res, path.join(serveRoot, 'index.html'));
          break;
        }
        default: {
          // substring to get rid of leading '/'
          sendFile(res, path.join(serveRoot, reqUrl.pathname.substring(1)));
          break;
        }
      }
    },);
  }

  public start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this._server.listening) {
        throw new Error('Server is already started');
      }
      const portTimeout = setTimeout(() => {
        reject(new Error('Timeout waiting for port'));
      }, 5000);
      this._server.on('listening', () => {
        const address = this._server.address();
        if (typeof address === 'string') {
          this.port = parseInt(address);
        } else if (address instanceof Object) {
          this.port = address.port;
        } else {
          throw new Error('Unable to determine port');
        }

        clearTimeout(portTimeout);

        // set state which will be used to redirect back to vscode (this is from github auth provider example)
        // this.state = `http://127.0.0.1:${this.port}/callback?nonce=${encodeURIComponent(this.nonce)}`;
        this.state = randomUUID();

        resolve(this.port);
      });
      this._server.on('connection', (socket: net.Socket) => {
        // Keep track of open sockets so we can destroy them when the server is stopped
        // This will no longer be needed once VS Code updates to Node v18.2 or greater
        this.openSockets.push(socket);
      });
      this._server.on('error', err => {
        reject(new Error(`Error listening to server: ${err}`));
      });
      this._server.on('close', () => {
        reject(new Error('Closed'));
      });
      this._server.listen(40475, '127.0.0.1');
    });
  }

  public stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._server.listening) {
        throw new Error('Server is not started');
      }

      // Manually destory all sockets so the server can fully close immediately
      for (const socket of this.openSockets) {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }

      this._server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public waitForOAuthResponse(): Promise<IOAuthResult> {
    return this._resultPromise;
  }
}
