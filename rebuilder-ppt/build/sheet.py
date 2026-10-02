import sys,glob
from PIL import Image
pre=sys.argv[1]; per=int(sys.argv[2]) if len(sys.argv)>2 else 6
fs=sorted(glob.glob(f'/tmp/claude-0/prev/{pre}-*.png'))
for si in range(0,len(fs),per):
    ims=[Image.open(f) for f in fs[si:si+per]]; w,h=ims[0].size; cols=2; rows=-(-len(ims)//cols)
    sh=Image.new('RGB',(w*cols,h*rows),'white')
    for i,im in enumerate(ims): sh.paste(im,((i%cols)*w,(i//cols)*h))
    sh.save(f'/tmp/claude-0/prev/sheet_{pre}_{si//per+1}.png')
print(len(fs))
