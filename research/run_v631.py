import numpy as np
import pandas as pd
import vectorbt as vbt
import requests, io, zipfile
from pathlib import Path

OUT=Path("research/results"); OUT.mkdir(parents=True,exist_ok=True)
def load(symbol):
    frames=[]
    for year in range(2020,2027):
        for month in range(1,13):
            if (year,month) >= (2026,11): continue
            name=f"{symbol}-1h-{year}-{month:02d}.zip"
            r=requests.get(f"https://data.binance.vision/data/spot/monthly/klines/{symbol}/1h/{name}",timeout=60)
            if r.status_code==404: continue
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                a=pd.read_csv(z.open(z.namelist()[0]),header=None).iloc[:,:6]
            a=a[pd.to_numeric(a[0],errors="coerce").notna()].astype(float)
            ts=a[0].where(a[0]<1e14,a[0]/1000)
            a.index=pd.to_datetime(ts,unit="ms",utc=True)
            a.columns=["timestamp","open","high","low","close","volume"]
            frames.append(a.drop(columns="timestamp"))
    if not frames: raise ValueError("No data")
    d=pd.concat(frames).sort_index()
    if d.index.has_duplicates or (d.high<d[["open","close","low"]].max(axis=1)).any() or (d.low>d[["open","close","high"]].min(axis=1)).any(): raise ValueError("Invalid OHLC")
    if (d.index.to_series().diff().dropna()!=pd.Timedelta(hours=1)).any():
        # Keep the longest contiguous observed segment; never fabricate candles.
        groups=d.index.to_series().diff().ne(pd.Timedelta(hours=1)).cumsum()
        counts=groups.value_counts(); d=d.loc[groups==counts.idxmax()]
        if len(d)<8760:raise ValueError("No contiguous year of data")
    return d
def load_fallback(symbol):
    # Public Binance market-data endpoint, same spot instrument.
    start=int(pd.Timestamp("2020-01-01",tz="UTC").timestamp()*1000)
    end=int(pd.Timestamp("2026-11-01",tz="UTC").timestamp()*1000)
    rows=[]
    session=requests.Session()
    while start<end:
        r=session.get("https://data-api.binance.vision/api/v3/klines",params=dict(symbol=symbol,interval="1h",startTime=start,endTime=end-1,limit=1000),timeout=30)
        r.raise_for_status()
        batch=r.json()
        if not batch:break
        rows.extend(x[:6] for x in batch)
        nxt=int(batch[-1][0])+3600000
        if nxt<=start:raise ValueError("Pagination stalled")
        start=nxt
    if not rows:raise ValueError("Empty API response")
    d=pd.DataFrame(rows,columns=["timestamp","open","high","low","close","volume"]).astype(float)
    d.index=pd.to_datetime(d.pop("timestamp"),unit="ms",utc=True)
    if d.index.has_duplicates or (d.index.to_series().diff().dropna()!=pd.Timedelta(hours=1)).any():raise ValueError("API gaps or duplicates")
    return d
def rma(s,n):
    x=s.dropna(); out=pd.Series(np.nan,index=s.index)
    if len(x)>=n:
        y=x.iloc[n-1:].copy(); y.iloc[0]=x.iloc[:n].mean()
        out.loc[y.index]=y.ewm(alpha=1/n,adjust=False).mean()
    return out
def profile(x):
    lo,hi=x.min(),x.max()
    if hi==lo:return pd.Series(dict(poc=lo,vah=hi,val=lo))
    f,e=np.histogram(x,bins=24,range=(lo,hi)); p=int(f.argmax()); l=h=p; count=f[p]
    while count<len(x)*.7 and (l>0 or h<len(f)-1):
        if h<len(f)-1 and (l==0 or f[h+1]>=f[l-1]): h+=1;count+=f[h]
        else:l-=1;count+=f[l]
    return pd.Series(dict(poc=(e[p]+e[p+1])/2,vah=e[h+1],val=e[l]))
def features(d,kc):
    c=d.close; prev=c.shift()
    atr=rma(pd.concat([d.high-d.low,(d.high-prev).abs(),(d.low-prev).abs()],axis=1).max(axis=1),20)
    sma=c.rolling(20).mean(); diff=(2*c.rolling(20).std(ddof=0)-kc*atr)/(sma+kc*atr)*100
    ch=diff.diff(); u=rma(ch.clip(lower=0),14); v=rma(-ch.clip(upper=0),14)
    rsi=(100-100/(1+u/v)).mask(v==0,100).mask((u==0)&(v!=0),0); ma=rsi.rolling(7).mean()
    bull=(rsi>ma)&(rsi.shift()<=ma.shift()); bear=(rsi<ma)&(rsi.shift()>=ma.shift())
    level=d.high.where(bull|bear).ffill().shift()
    p=pd.DataFrame([dict(profile(g)) for _,g in c.groupby(c.index.floor("D"))],index=c.index.floor("D").unique()).shift(1).reindex(c.index.floor("D")); p.index=c.index
    trend=c.ewm(span=12,adjust=False).mean()>c.ewm(span=26,adjust=False).mean()
    br=(c>level)&(prev<=level); bd=(c<level)&(prev>=level)
    bounce=(prev>level)&(d.low<=level)&(c>level)
    reject=(prev<level)&(d.high>=level)&(c<level)
    va=(c>p.vah)&(prev<=p.vah); re=(c>p.val)&(prev<=p.val)&(c<=p.vah)
    release=(diff>0)&(diff.shift()<=0)
    extra=structure(d,bull|bear,atr,p,diff)
    return {**extra,"cross":bull,"release":release,"sr_break":br,"sr_bounce":bounce,"va_break":va,"va_reentry":re,"sr_val":bounce&((level-p.val).abs()<=.5*atr),"sr_expansion":br&(diff>0),"double_break":br&(c>p.vah),"trend_sr":bounce&trend,"sr_break_short":bd,"sr_reject_short":reject},bear,bd
def structure(d,cross,atr,p,diff):
    # Levels become available only on the following bar.
    levels=[]; rows=[]
    for i,(o,h,l,c) in enumerate(d[["open","high","low","close"]].itertuples(index=False,name=None)):
        prev=d.close.iloc[i-1] if i else np.nan
        a=atr.iloc[i]; active=[x for x in levels if i-x[1]<=720]
        supports=[x for x in active if x[0]<prev]
        resistances=[x for x in active if x[0]>prev]
        s=max(supports,key=lambda x:x[0],default=None)
        r=min(resistances,key=lambda x:x[0],default=None)
        bounce=bool(s and l<=s[0]<c)
        br=bool(r and c>r[0])
        reject=bool(r and h>=r[0]>c)
        bd=bool(s and c<s[0])
        rows.append(dict(multi_bounce=bounce,multi_break=br,multi_reject_short=reject,multi_break_short=bd,
            first_touch=bounce and s[2]==0 and not s[3],repeat_touch=bounce and s[2]>0 and not s[3],
            old_support=bounce and i-s[1]>=24,
            multi_val=bounce and abs(s[0]-p.val.iloc[i])<=.5*a,
            multi_poc=bounce and abs(s[0]-p.poc.iloc[i])<=.5*a,
            multi_expansion=br and diff.iloc[i]>0,
            multi_compression=bounce and diff.iloc[i]<=0))
        for x in active:
            touching=l<=x[0]<=h
            if touching and not x[3]:x[2]+=1
            x[3]=touching
        levels=active
        if cross.iloc[i]:levels.append([h,i,0,True])
        levels=levels[-20:]
    return {k:v.astype(bool) for k,v in pd.DataFrame(rows,index=d.index).items()}
def causal_test():
    rng=np.random.default_rng(42)
    idx=pd.date_range("2023-01-01",periods=400,freq="h",tz="UTC")
    c=pd.Series(100+np.cumsum(rng.normal(size=len(idx))),index=idx)
    d=pd.DataFrame(dict(open=c,high=c+1,low=c-1,close=c,volume=1))
    for kc in [1.5,2.0]:
        full=features(d,kc)[0]; prefix=features(d.iloc[:300],kc)[0]
        for k in full:pd.testing.assert_series_equal(full[k].iloc[:300],prefix[k])
def detailed_events(d,sig,symbol,kc):
    rows=[]
    close=d.close; atr=rma(pd.concat([d.high-d.low,(d.high-close.shift()).abs(),(d.low-close.shift()).abs()],axis=1).max(axis=1),20)
    trend=close/close.rolling(200).mean()-1
    vol=close.pct_change().rolling(24).std(); volrank=vol.rolling(720,min_periods=240).rank(pct=True)
    p=pd.DataFrame([dict(profile(g)) for _,g in close.groupby(close.index.floor("D"))],index=close.index.floor("D").unique()).shift(1).reindex(close.index.floor("D"));p.index=close.index
    for name,s in sig.items():
        side=-1 if name.endswith("_short") else 1
        for i in np.flatnonzero(s.to_numpy()):
            j=i+1
            if j+168>=len(d):continue
            entry=d.open.iloc[j]
            split="IS" if d.index[i].year<2024 else "OOS"
            for h in [1,5,12,24,48,72,120,168]:
                if (d.index[j+h].year<2024)!=(split=="IS"):continue
                w=d.iloc[j:j+h]
                ret=side*(d.open.iloc[j+h]/entry-1)
                mfe=(w.high.max()/entry-1) if side==1 else (1-w.low.min()/entry)
                mae=(w.low.min()/entry-1) if side==1 else (1-w.high.max()/entry)
                best=w.high.to_numpy() if side==1 else -w.low.to_numpy()
                worst=-w.low.to_numpy() if side==1 else w.high.to_numpy()
                a=atr.iloc[i]
                rows.append((symbol,kc,name,d.index[i],split,h,entry,ret,mfe,mae,int(best.argmax()+1),int(worst.argmax()+1),trend.iloc[i],volrank.iloc[i],(close.iloc[i]-p.poc.iloc[i])/a,(close.iloc[i]-p.val.iloc[i])/a,(close.iloc[i]-p.vah.iloc[i])/a,(p.vah.iloc[i]-p.val.iloc[i])/a))
    return pd.DataFrame(rows,columns=["symbol","kc","strategy","signal_time","split","horizon","entry","return","mfe","mae","hours_to_mfe","hours_to_mae","trend200","vol_percentile","poc_distance_atr","val_distance_atr","vah_distance_atr","va_width_atr"])

def adaptive(d,sig,symbol,kc):
    # Annual walk-forward: select only from completed prior-year net event outcomes.
    c=d.close; trend=c>c.rolling(200).mean()
    vol=c.pct_change().rolling(24).std()
    highvol=vol>vol.rolling(720,min_periods=240).median()
    regime=trend.astype(int)*2+highvol.astype(int)
    candidates=[]
    for name,s in sig.items():
        if name.endswith("_short"):continue
        for h in [12,24,48,72,120,168]:
            ret=d.open.shift(-h-1)/d.open.shift(-1)*(1-.001)*(1-.0002)/((1+.001)*(1+.0002))-1
            candidates.append((name,h,s,ret))
    rows=[]; selections=[]
    for year in [2024,2025,2026]:
        z=d.loc[d.index.year==year]
        if len(z)<200:continue
        chosen={}
        for rg in range(4):
            scores=[]
            for name,h,s,ret in candidates:
                m=(d.index.year<year)&(d.index.year>=year-1)&(regime==rg)&s
                m=m & (pd.Series(d.index,index=d.index).shift(-h-1)<z.index[0])
                x=ret[m].dropna()
                # Thin overlapping observations before scoring.
                keep=[]; last=None
                for t in x.index:
                    if last is None or t-last>=pd.Timedelta(hours=h+1):keep.append(t);last=t
                x=x.loc[keep]
                if len(x)>=20 and x.std()>0:
                    score=x.mean()/x.std()*np.sqrt(len(x))
                    if score>0:scores.append((score,name,h,s,len(x)))
            if scores:
                score,name,h,s,n=max(scores,key=lambda x:x[0])
                chosen[rg]=(name,h,s)
                selections.append(dict(symbol=symbol,kc=kc,year=year,regime=rg,strategy=name,hold=h,train_n=n,train_score=score))
        en=np.zeros(len(z),bool);ex=en.copy();last=-1
        for i in range(1,len(z)):
            if i<=last:continue
            rg=regime.loc[z.index[i-1]]
            if rg not in chosen:continue
            name,h,s=chosen[rg]
            if s.loc[z.index[i-1]] and i+h<len(z):
                en[i]=True;ex[i+h]=True;last=i+h
        pf=vbt.Portfolio.from_signals(z.close,en,ex,price=z.open,fees=.001,slippage=.0002,init_cash=10000,freq="1h")
        daily=pf.value().resample("D").last().pct_change().dropna()
        rows.append(dict(symbol=symbol,kc=kc,year=year,trades=int(pf.trades.count()),return_pct=pf.total_return()*100,maxdd_pct=pf.max_drawdown()*100,sharpe=daily.mean()/daily.std()*np.sqrt(365) if daily.std()>0 else np.nan,positive_days=(daily>0).mean(),buyhold_pct=(z.close.iloc[-1]/z.open.iloc[0]-1)*100))
    for data,kind in [(rows,"adaptive"),(selections,"adaptive_selection")]:
        pd.DataFrame(data).to_csv(OUT/f"{kind}_{symbol}_{kc}.csv",index=False)

def conditional_summary():
    parts=[]
    for path in OUT.glob("event_detail_*.csv.gz"):
        x=pd.read_csv(path)
        x["trend"]=np.where(x.trend200>0,"up","down")
        x["vol"]=pd.cut(x.vol_percentile,[0,.33,.67,1],include_lowest=True)
        x["poc_band"]=pd.cut(x.poc_distance_atr,[-np.inf,-2,-.5,.5,2,np.inf])
        x["net_return"]=x["return"]-.0024
        for feature in ["trend","vol","poc_band"]:
            g=x.groupby(["symbol","kc","strategy","split","horizon",feature],observed=True).agg(n=("return","size"),mean=("return","mean"),net_mean=("net_return","mean"),median=("return","median"),win=("net_return",lambda s:(s>0).mean()),mfe=("mfe","median"),mae=("mae","median"),time_mfe=("hours_to_mfe","median")).reset_index().rename(columns={feature:"bucket"})
            g["feature"]=feature;parts.append(g)
    if parts:pd.concat(parts,ignore_index=True).to_csv(OUT/"conditional_eda.csv",index=False)

def run():
    results=[]; events=[]; errors=[]
    for symbol in ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]:
        try:d=load(symbol)
        except Exception as e:
            print(f"Binance archive {symbol}: {e!r}",flush=True)
            try:d=load_fallback(symbol)
            except Exception as e2:
                print(f"Fallback {symbol}: {e2!r}",flush=True)
                errors.append({"symbol":symbol,"error":str(e),"fallback_error":str(e2)});continue
        print(f"Loaded {symbol}: {len(d)} bars {d.index.min()} to {d.index.max()}",flush=True)
        for kc in [1.5,2.0]:
            sig,bear,bd=features(d,kc)
            adaptive(d,sig,symbol,kc)
            detailed_events(d,sig,symbol,kc).to_csv(OUT/f"event_detail_{symbol}_{kc}.csv.gz",index=False)
            for name,s in sig.items():
                short=name.endswith("_short")
                for horizon in [1,5,10,24,72]:
                    ret=(d.open.shift(-horizon-1)/d.open.shift(-1)-1)*(-1 if short else 1)
                    for split,mask in [("IS",d.index.year<2024),("OOS",d.index.year>=2024)]:
                        m=pd.Series(mask,index=d.index); valid=m.shift(-horizon-1,fill_value=False)&m
                        x=ret[s&valid].dropna(); base=ret[valid].dropna()
                        events.append(dict(symbol=symbol,kc=kc,strategy=name,horizon=horizon,split=split,n=len(x),mean=x.mean(),median=x.median(),win=(x>0).mean() if len(x) else np.nan,baseline=base.mean()))
                for split,mask in [("IS",d.index.year<2024),("OOS",d.index.year>=2024)]:
                    z=d.loc[mask]; entry=s.shift(1,fill_value=False).loc[z.index].copy()
                    if len(z)<100:continue
                    entry.iloc[0]=False
                    for hold in [5,24,72]:
                        # Non-overlapping fixed-horizon positions, executed at next open.
                        en=np.zeros(len(z),bool); ex=en.copy(); last=-1
                        for i in np.flatnonzero(entry.to_numpy()):
                            if i>last and i+hold<len(z):en[i]=True;ex[i+hold]=True;last=i+hold
                        for fee in [.0005,.001,.002]:
                            pf=vbt.Portfolio.from_signals(z.close,en,ex,price=z.open,fees=fee,slippage=.0002,init_cash=10000,freq="1h",direction="shortonly" if short else "longonly")
                            if fee==.001:
                                orders=pf.orders.records_readable.copy(); trades=pf.trades.records_readable.copy()
                                for frame,kind in [(orders,"orders"),(trades,"trades")]:
                                    frame=frame.assign(symbol=symbol,kc=kc,strategy=name,split=split,hold=hold,fee=fee)
                                    path=OUT/f"{kind}_{symbol}.csv.gz"
                                    frame.to_csv(path,mode="a",header=not path.exists(),index=False)
                            daily=pf.value().resample("D").last().pct_change().dropna()
                            results.append(dict(symbol=symbol,kc=kc,strategy=name,split=split,hold=hold,fee=fee,trades=int(pf.trades.count()),return_pct=float(pf.total_return()*100),maxdd_pct=float(pf.max_drawdown()*100),sharpe=float(daily.mean()/daily.std()*np.sqrt(365)) if daily.std()>0 else np.nan,profit_factor=float(pf.trades.profit_factor()),positive_days=float((daily>0).mean())))
        print(f"Completed {symbol}: {len(results)} cumulative backtests",flush=True)
        pd.DataFrame(results).to_csv(OUT/"backtest.csv",index=False);pd.DataFrame(events).to_csv(OUT/"events.csv",index=False)
    pd.DataFrame(errors,columns=["symbol","error","fallback_error"]).to_csv(OUT/"errors.csv",index=False)
    conditional_summary()
    if not results:raise RuntimeError("No real market backtests completed")
if __name__=="__main__":
    causal_test()
    run()
