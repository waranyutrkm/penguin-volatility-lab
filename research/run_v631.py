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
    if (d.index.to_series().diff().dropna()!=pd.Timedelta(hours=1)).any(): raise ValueError("Missing bars")
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
    p=c.groupby(c.index.floor("D")).apply(profile).unstack().shift(1).reindex(c.index.floor("D")); p.index=c.index
    trend=c.ewm(span=12,adjust=False).mean()>c.ewm(span=26,adjust=False).mean()
    br=(c>level)&(prev<=level); bd=(c<level)&(prev>=level)
    bounce=(prev>level)&(d.low<=level)&(c>level)
    reject=(prev<level)&(d.high>=level)&(c<level)
    va=(c>p.vah)&(prev<=p.vah); re=(c>p.val)&(prev<=p.val)&(c<=p.vah)
    release=(diff>0)&(diff.shift()<=0)
    return {"cross":bull,"release":release,"sr_break":br,"sr_bounce":bounce,"va_break":va,"va_reentry":re,"sr_val":bounce&((level-p.val).abs()<=.5*atr),"sr_expansion":br&(diff>0),"double_break":br&(c>p.vah),"trend_sr":bounce&trend,"sr_break_short":bd,"sr_reject_short":reject},bear,bd
def run():
    results=[]; events=[]; errors=[]
    for symbol in ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]:
        try:d=load(symbol)
        except Exception as e:errors.append({"symbol":symbol,"error":str(e)});continue
        for kc in [1.5,2.0]:
            sig,bear,bd=features(d,kc)
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
                            daily=pf.value().resample("D").last().pct_change().dropna()
                            results.append(dict(symbol=symbol,kc=kc,strategy=name,split=split,hold=hold,fee=fee,trades=int(pf.trades.count()),return_pct=float(pf.total_return()*100),maxdd_pct=float(pf.max_drawdown()*100),sharpe=float(daily.mean()/daily.std()*np.sqrt(365)) if daily.std()>0 else np.nan,profit_factor=float(pf.trades.profit_factor()),positive_days=float((daily>0).mean())))
        pd.DataFrame(results).to_csv(OUT/"backtest.csv",index=False);pd.DataFrame(events).to_csv(OUT/"events.csv",index=False)
    pd.DataFrame(errors,columns=["symbol","error"]).to_csv(OUT/"errors.csv",index=False)
    if not results:raise RuntimeError("No real market backtests completed")
if __name__=="__main__":run()
