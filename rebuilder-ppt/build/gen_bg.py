"""REBUILDER 강의 PPT 배경 11종 생성 (1920x1080 JPEG)."""
from PIL import Image, ImageDraw, ImageFilter
import random, math, os
W,H=1920,1080
OUT=os.path.join(os.path.dirname(__file__),'..','assets','bg')
random.seed(7)

def grad(top,bot,w=W,h=H):
    im=Image.new('RGB',(w,h)); d=ImageDraw.Draw(im)
    for y in range(h):
        t=y/(h-1); d.line([(0,y),(w,y)],fill=tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3)))
    return im
def cloud(d,x,y,s,col=(255,255,255)):
    for dx,dy,r in [(0,0,1.0),(0.9,-0.25,1.2),(1.9,0,1.0),(0.9,0.25,1.1),(-0.6,0.2,0.7),(2.5,0.2,0.7)]:
        d.ellipse([x+dx*s-r*s*0.6,y+dy*s-r*s*0.5,x+dx*s+r*s*0.6,y+dy*s+r*s*0.5],fill=col)
def hills(im,base,cols,amp=90):
    d=ImageDraw.Draw(im)
    for k,c in enumerate(cols):
        pts=[(0,H)]
        ph=random.random()*6
        for x in range(0,W+20,20):
            y=base+k*60+amp*math.sin(x/(380+k*90)+ph)*0.6+amp*0.4*math.sin(x/170+k)
            pts.append((x,y))
        pts.append((W,H)); d.polygon(pts,fill=c)
def save(im,name): im.convert('RGB').save(os.path.join(OUT,name+'.jpg'),quality=88)

# SKY
im=grad((158,214,250),(232,246,255)); d=ImageDraw.Draw(im)
for _ in range(7): cloud(d,random.randint(0,W),random.randint(40,420),random.randint(50,90))
hills(im,820,[(150,214,160),(104,190,120),(120,200,90)],70)
d=ImageDraw.Draw(im)
d.polygon([(700,H),(900,900),(1100,830),(1250,820),(1350,840),(1100,870),(980,930),(1000,H)],fill=(226,244,190))
save(im,'SKY')
# BOARD
im=grad((236,226,206),(200,168,120)); d=ImageDraw.Draw(im)
for y in range(0,H,36): d.line([(0,y),(W,y)],fill=(190,158,112),width=2)
d.rounded_rectangle([24,56,W-24,H-84],radius=26,fill=(122,86,52))
d.rounded_rectangle([48,80,W-48,H-108],radius=14,fill=(46,78,68))
d.rounded_rectangle([66,98,W-66,H-126],radius=10,outline=(190,214,196),width=3)
d.rectangle([0,H-72,W,H],fill=(168,122,78))
save(im,'BOARD')
# NOTE
im=grad((240,251,246),(225,244,238)); d=ImageDraw.Draw(im)
for y in range(0,H,54): d.line([(0,y),(W,y)],fill=(206,232,224),width=2)
for x in range(0,W,54): d.line([(x,0),(x,H)],fill=(214,236,229),width=1)
hills(im,930,[(190,232,205),(160,220,180)],40)
save(im,'NOTE')
# NIGHT
im=grad((12,22,48),(38,58,110)); d=ImageDraw.Draw(im)
for _ in range(220):
    x,y=random.randint(0,W),random.randint(0,H-200); r=random.choice([1,1,2,3]); d.ellipse([x,y,x+r,y+r],fill=(255,250,225))
hills(im,900,[(18,30,60),(10,18,40)],50)
save(im,'NIGHT')
# WARM
im=grad((255,244,224),(255,208,166)); d=ImageDraw.Draw(im)
g=Image.new('RGB',(W,H),(0,0,0)); gd=ImageDraw.Draw(g); gd.ellipse([660,560,1260,1160],fill=(255,214,120)); g=g.filter(ImageFilter.GaussianBlur(120))
im=Image.blend(im,Image.composite(g,im,g.convert('L')),0.5)
hills(im,880,[(240,176,128),(214,140,100)],60)
save(im,'WARM')
# CLEAN
im=grad((250,251,253),(236,240,246)); d=ImageDraw.Draw(im)
for x in range(0,W,80): d.line([(x,0),(x,H)],fill=(228,233,241),width=1)
for y in range(0,H,80): d.line([(0,y),(W,y)],fill=(228,233,241),width=1)
save(im,'CLEAN')
# contour helper
def contours(im,col,n=14,cx=1350,cy=520):
    d=ImageDraw.Draw(im)
    for i in range(1,n+1):
        pts=[]
        for a in range(0,361,4):
            r=i*58+30*math.sin(a/20*math.pi/3+i)+22*math.sin(a*math.pi/45+i*0.7)
            pts.append((cx+r*math.cos(math.radians(a))*1.25,cy+r*math.sin(math.radians(a))*0.8))
        d.line(pts,fill=col,width=2)
# MAP
im=grad((226,234,244),(205,218,234)); contours(im,(190,206,226)); save(im,'MAP')
# PAPER
im=grad((246,243,235),(238,233,221)); d=ImageDraw.Draw(im)
for _ in range(6000):
    x,y=random.randint(0,W),random.randint(0,H); d.point((x,y),fill=(226,220,206))
save(im,'PAPER')
# DUSK
im=grad((24,24,56),(70,50,98)); d=ImageDraw.Draw(im)
for _ in range(90):
    x,y=random.randint(0,W),random.randint(0,600); r=random.choice([1,2]); d.ellipse([x,y,x+r,y+r],fill=(255,240,220))
save(im,'DUSK')
# DAWN
top=(14,30,64); mid=(120,86,110); bot=(244,176,92)
im=Image.new('RGB',(W,H)); d=ImageDraw.Draw(im)
for y in range(H):
    t=y/(H-1)
    c=[int(top[i]+(mid[i]-top[i])*min(t/0.65,1)) for i in range(3)] if t<0.65 else [int(mid[i]+(bot[i]-mid[i])*((t-0.65)/0.35)) for i in range(3)]
    d.line([(0,y),(W,y)],fill=tuple(c))
hills(im,930,[(40,38,70),(26,24,52)],45)
save(im,'DAWN')
# SLATE
im=grad((14,22,34),(28,40,58)); d=ImageDraw.Draw(im)
for x in range(0,W,96): d.line([(x,0),(x,H)],fill=(24,36,52),width=1)
for y in range(0,H,96): d.line([(0,y),(W,y)],fill=(24,36,52),width=1)
save(im,'SLATE')
# CONTOUR
im=grad((12,20,32),(24,36,54)); contours(im,(36,54,78),cx=1450,cy=480); save(im,'CONTOUR')
print(sorted(os.listdir(OUT)))
