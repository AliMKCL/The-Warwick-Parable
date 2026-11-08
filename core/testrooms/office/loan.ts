import { Builder } from '../../room/layouts';
import { createRng, deriveSeed } from '../../util/random';
import { cells } from './geometry';
import type { ModuleCtx, OfficeTaskModule } from './module';
import { first, of, r2 } from './util';

/**
 * 10b. The Coffee-Token Loan (office version of the Stranded Miner): trust and trustworthiness.
 *
 * The Trust Game (Berg, Dickhaut and McCabe, 1995). A colleague asks to
 * borrow coffee tokens: whatever is lent is tripled on payday, and they
 * share some back. The player has `endowment` tokens each round and lends 0
 * to all of them. The colleague is fair (returns about half the tripled
 * amount) or a cheat (returns nothing), drawn per session. Two trusting
 * rounds, then the roles flip: another colleague sends the player tokens,
 * tripled, and asks for a share back (the player's own trustworthiness).
 */
export const loan: OfficeTaskModule = {
  id: 'loan',
  number: '10b',
  needs: {
    fixtures: [
      { id: 't_borrower', recipe: 'colleague_talk', what: 'the colleague who borrows tokens (talk to them for each round)' },
      { id: 't_lender', recipe: 'colleague_talk_b', what: 'the colleague who sends the player tokens (the roles-flipped round)' },
    ],
    zones: [],
    doors: 'one exit, always open',
  },

  defaults(seed) {
    const rng = createRng(deriveSeed(seed, 'loan-partner'));
    return { partner: rng() < 0.5 ? 'fair' : 'cheat', endowment: 10, flipSent: 4, rounds: 2 };
  },

  layout(_p, rng, data) {
    const W = 8, D = 7;
    const t = data.tasks.office.loan;
    const b = new Builder('coffee_nook', W, D, 3.0, { rng, doorLabels: [] });
    const ex = b.entrance(4);
    const exit = b.door('n', 4, { label: t.labels!.exit });
    b.fixture({ id: 't_borrower', recipe: 'colleague_talk', x: 2.3, z: 2.6, face: 'e', y: 0 }, cells(1, 1, 3, 3));
    b.fixture({ id: 't_lender', recipe: 'colleague_talk_b', x: 5.8, z: 3.4, face: 'w', y: 0 }, cells(5, 2, 6, 4));
    b.fixture({ id: 't_machine', recipe: 'coffee_machine', x: 0.33, z: 5, face: 'e', y: 0, surfaceText: t.labels!.machine });
    b.wallSlots();
    b.spawnAt(ex);
    return { layout: b.done(), extra: { exitDoor: exit } };
  },

  begin(ctx) {
    ctx.state.round = 0;
    ctx.state.tokens = Number(ctx.p.endowment) || 10;
    ctx.say('intro');
    status(ctx);
  },

  onEvent(ctx, e) {
    const s = ctx.state;
    const endow = Number(ctx.p.endowment) || 10;
    if (e.type === 'pressed' && e.objectId === 't_borrower') {
      if (s.asking) return;
      const round = Number(s.round) + 1;
      if (round > (Number(ctx.p.rounds) || 2)) return ctx.say(`borrowerDone${round}`, ctx.text.lines.borrowerDone);
      s.asking = `lend${round}`;
      ctx.emit({ kind: 'glance', prop: 't_borrower', at: 'player', seconds: 2 });
      ctx.ask({ id: `lend${round}`, mode: 'slider', title: round === 1 ? ctx.text.labels!.lendTitle! : ctx.text.labels!.lendAgain!, text: ctx.text.labels!.lendText, min: 0, max: endow, step: 1, value: 0, unit: ' tokens' });
    } else if (e.type === 'pressed' && e.objectId === 't_lender') {
      if (s.asking || s.flipped) return;
      s.asking = 'return';
      const received = (Number(ctx.p.flipSent) || 4) * 3;
      ctx.emit({ kind: 'glance', prop: 't_lender', at: 'player', seconds: 2 });
      ctx.ask({ id: 'return', mode: 'slider', title: ctx.text.labels!.returnTitle!.replaceAll('{received}', String(received)), text: ctx.text.labels!.returnText, min: 0, max: received, step: 1, value: 0, unit: ' tokens' });
    } else if (e.type === 'answer' && e.askId === s.asking) {
      s.asking = undefined;
      if (e.askId.startsWith('lend')) {
        const round = Number(s.round) + 1;
        s.round = round;
        const sent = Math.round(e.value);
        const pot = sent * 3;
        const returned = ctx.p.partner === 'fair' ? Math.round(pot / 2) : 0;
        s.tokens = endow - sent + returned;
        ctx.log('trust_send', { round, sent, pot, returned, type: ctx.p.partner, seconds: r2(e.seconds) });
        ctx.log('outcome', { round, returned });
        ctx.say(`repaid${round}`, !sent ? ctx.text.lines.nothingLent : returned ? ctx.text.lines.repaid!.replaceAll('{n}', String(returned)) : ctx.text.lines.cheated);
      } else {
        const received = (Number(ctx.p.flipSent) || 4) * 3;
        const returned = Math.round(e.value);
        s.flipped = true;
        ctx.log('trust_return', { received, returned, seconds: r2(e.seconds) });
        ctx.say('thanks', returned ? ctx.text.lines.thanks : ctx.text.lines.noReturn);
      }
      status(ctx);
    }
  },

  onLeave(ctx) {
    ctx.emit({ kind: 'status', text: null });
  },

  score(ev, { params }) {
    const endow = Number(params.endowment) || 10;
    const r1 = first(ev, 'trust_send', (d) => d.round === 1);
    const r2nd = first(ev, 'trust_send', (d) => d.round === 2);
    const back = first(ev, 'trust_return');
    const metrics = {
      initial_trust: r1 ? r2(Number(r1.data.sent) / endow) : null,
      trust_update: r1 && r2nd ? Number(r2nd.data.sent) - Number(r1.data.sent) : null,
      partner_fair: params.partner === 'fair' ? 1 : 0,
      trustworthiness: back ? r2(Number(back.data.returned) / Number(back.data.received)) : null,
      rounds: of(ev, 'trust_send').length + (back ? 1 : 0),
    };
    const notes: string[] = [];
    if (r1) notes.push(`You lent a colleague ${r1.data.sent} of your ${endow} coffee tokens.`);
    if (r1 && r2nd) {
      const d = Number(r2nd.data.sent) - Number(r1.data.sent);
      const how = params.partner === 'fair' ? 'After they paid you back' : 'After they kept the lot';
      notes.push(`${how}, you lent ${d === 0 ? 'the same again' : d > 0 ? `${d} more` : `${-d} fewer`}.`);
    }
    if (back) notes.push(`Trusted with ${back.data.received} tokens yourself, you gave ${back.data.returned} back.`);
    if (!notes.length) notes.push('Nobody got to borrow your coffee tokens.');
    return { metrics, notes };
  },

  profile(m, adjust) {
    if (m.trustworthiness !== null && m.trustworthiness !== undefined && m.trustworthiness >= 0.4) adjust('compliance', 0.05, 'paid back a colleague who trusted it');
  },
};

function status(ctx: ModuleCtx) {
  ctx.emit({ kind: 'status', text: `${ctx.text.labels!.tokens}: ${ctx.state.tokens}` });
}
