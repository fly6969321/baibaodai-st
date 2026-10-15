import { guard } from './state.js';
import { apiConfig } from './config.js';
import { callModel } from './relay.js';

export async function ask(job, kind, prompt, body, options) {
    options = options || {};
    const conn = job.connections ? job.connections[kind] : apiConfig(kind);
    await guard(job);
    const budget = job.deadline - Date.now();
    const seconds = Math.max(1, Math.min((options.timeout || conn.timeout) * 1000, budget) / 1000);
    const result = await Promise.race([
        callModel(conn, prompt, body, {
            timeout: seconds,
            signal: job.signal,
            maxTokens: options.maxTokens || (kind === 'coord' ? 1200 : 1800),
            temperature: kind === 'coord' ? 0.6 : 0.95,
            allowPartial: options.allowPartial,
            missing: kind === 'coord' ? '场外小叮当 API 地址或模型未配置' : '创意空投机 API 地址或模型未配置',
        }),
        job.cancelPromise,
    ]);
    await guard(job);
    return result;
}
